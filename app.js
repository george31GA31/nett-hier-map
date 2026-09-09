(() => {
  "use strict";

  const config = window.NETT_HIER_CONFIG || {};
  const key = String(config.supabasePublishableKey || config.supabaseAnonKey || "").trim();
  const live = Boolean(config.supabaseUrl && key && window.supabase);
  const db = live ? window.supabase.createClient(config.supabaseUrl, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  }) : null;

  const state = {
    mode: "add",
    editingId: null,
    adding: false,
    selectedLatLng: null,
    location: null,
    locationLookupPromise: null,
    spots: [],
    previewUrl: null,
    realtimeChannel: null,
    geocodeCache: new Map()
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    brandHome: $("brandHome"),
    tabButtons: [...document.querySelectorAll(".tab-button")],
    mapView: $("mapView"), statsView: $("statsView"), stickersView: $("stickersView"),
    mapShell: document.querySelector(".map-shell"),
    spotCount: $("spotCount"), addButton: $("addButton"), myLocationButton: $("myLocationButton"),
    cancelAddMode: $("cancelAddMode"), addModeNotice: $("addModeNotice"), mapIntro: $("mapIntro"),
    modeBadge: $("modeBadge"),
    statsTotal: $("statsTotal"), statsCountries: $("statsCountries"), statsTopCountry: $("statsTopCountry"),
    countryRanking: $("countryRanking"),
    dialog: $("sightingDialog"), form: $("sightingForm"), dialogEyebrow: $("dialogEyebrow"),
    dialogTitle: $("dialogTitle"), closeDialog: $("closeDialog"), cancelDialog: $("cancelDialog"),
    coordinateText: $("coordinateText"), detectedLocation: $("detectedLocation"),
    photoFieldWrap: $("photoFieldWrap"), photoInput: $("photoInput"),
    photoPreviewWrap: $("photoPreviewWrap"), photoPreview: $("photoPreview"),
    dateInput: $("dateInput"), noteInput: $("noteInput"), addedByInput: $("addedByInput"),
    formMessage: $("formMessage"), submitButton: $("submitButton")
  };

  if (!window.L) {
    els.modeBadge.textContent = "Map library failed to load — refresh the page";
    return;
  }

  const WORLD_BOUNDS = L.latLngBounds([-85.0511, -180], [85.0511, 180]);
  const map = L.map("map", {
    minZoom: 2, maxZoom: 19, zoomControl: true, worldCopyJump: false,
    maxBounds: WORLD_BOUNDS, maxBoundsViscosity: 0.9
  }).setView([22, 7], 2);

  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    minZoom: 2, maxZoom: 19, noWrap: true, bounds: WORLD_BOUNDS,
    updateWhenIdle: true, keepBuffer: 2,
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);

  const markerLayer = L.markerClusterGroup({
    showCoverageOnHover: false, maxClusterRadius: 45, removeOutsideVisibleBounds: true
  });
  map.addLayer(markerLayer);

  const markerIcon = L.divIcon({
    className: "",
    html: '<div class="nett-marker"><span>N</span></div>',
    iconSize: [31,31], iconAnchor: [15,30], popupAnchor: [0,-29]
  });

  const resizeMap = () => requestAnimationFrame(() => map.invalidateSize({ pan: false }));
  addEventListener("resize", resizeMap, { passive: true });
  addEventListener("orientationchange", () => setTimeout(resizeMap, 180), { passive: true });
  if (window.ResizeObserver) new ResizeObserver(resizeMap).observe(els.mapShell);
  setTimeout(resizeMap, 100);

  function today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  }
  els.dateInput.value = today();

  function setStatus(text, isLive = false) {
    els.modeBadge.textContent = text;
    els.modeBadge.classList.toggle("live", isLive);
  }
  setStatus(live ? "Connecting to shared map…" : "Demo mode");

  function switchView(name) {
    els.mapView.hidden = name !== "map";
    els.statsView.hidden = name !== "stats";
    els.stickersView.hidden = name !== "stickers";
    els.tabButtons.forEach(btn => {
      const active = btn.dataset.view === name;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", String(active));
    });
    if (name === "map") setTimeout(resizeMap, 20);
    if (name === "stats") renderStats();
  }

  els.tabButtons.forEach(btn => btn.addEventListener("click", () => switchView(btn.dataset.view)));
  els.brandHome.addEventListener("click", () => switchView("map"));

  function setAdding(on) {
    state.adding = !!on;
    els.mapShell.classList.toggle("adding", state.adding);
    els.addModeNotice.hidden = !state.adding;
    els.mapIntro.hidden = state.adding;
  }

  els.addButton.addEventListener("click", () => {
    switchView("map");
    setAdding(!state.adding);
  });
  els.cancelAddMode.addEventListener("click", () => setAdding(false));

  map.on("click", e => {
    if (!state.adding) return;
    setAdding(false);
    openAddAt(e.latlng.lat, e.latlng.lng, false);
  });

  els.myLocationButton.addEventListener("click", () => {
    switchView("map");
    if (!navigator.geolocation) return setStatus("Location is not supported by this browser");

    els.myLocationButton.disabled = true;
    els.myLocationButton.textContent = "Finding you…";
    navigator.geolocation.getCurrentPosition(
      pos => {
        const { latitude: lat, longitude: lng } = pos.coords;
        map.setView([lat, lng], 16, { animate: true });
        resetLocationButton();
        openAddAt(lat, lng, true);
      },
      err => {
        console.error(err);
        resetLocationButton();
        setStatus(err.code === 1
          ? "Location permission denied — tap the map instead"
          : "Could not get your location — tap the map instead");
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 15000 }
    );
  });

  function resetLocationButton() {
    els.myLocationButton.disabled = false;
    els.myLocationButton.innerHTML = '<span class="location-dot" aria-hidden="true"></span> Plot my location';
  }

  function safeText(v, max) { return String(v || "").trim().slice(0, max); }

  async function reverseGeocode(lat, lng) {
    const cacheKey = `${lat.toFixed(4)},${lng.toFixed(4)}`;
    if (state.geocodeCache.has(cacheKey)) return state.geocodeCache.get(cacheKey);

    const url = new URL("https://nominatim.openstreetmap.org/reverse");
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("lat", String(lat));
    url.searchParams.set("lon", String(lng));
    url.searchParams.set("zoom", "10");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("accept-language", navigator.language || "en");

    const res = await fetch(url.toString(), { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`Location lookup failed (${res.status})`);
    const data = await res.json();
    const a = data.address || {};
    const locality = a.city || a.town || a.village || a.municipality || a.county || a.state_district || a.state || "";
    const country = a.country || "";
    const countryCode = String(a.country_code || "").toUpperCase() || null;
    const place = locality && country && locality !== country
      ? `${locality}, ${country}`
      : (locality || country || data.display_name || `${lat.toFixed(5)}, ${lng.toFixed(5)}`);

    const result = { place: safeText(place, 120), country: safeText(country, 100) || null, countryCode };
    state.geocodeCache.set(cacheKey, result);
    return result;
  }

  function beginLocationLookup(lat, lng) {
    state.location = null;
    els.detectedLocation.textContent = "Finding location…";
    state.locationLookupPromise = reverseGeocode(lat, lng)
      .then(loc => {
        state.location = loc;
        els.detectedLocation.textContent = loc.place;
        return loc;
      })
      .catch(err => {
        console.warn(err);
        const fallback = { place: `${lat.toFixed(5)}, ${lng.toFixed(5)}`, country: null, countryCode: null };
        state.location = fallback;
        els.detectedLocation.textContent = "Location name unavailable — coordinates will be saved.";
        return fallback;
      });
  }

  function openAddAt(lat, lng, fromDevice) {
    state.mode = "add";
    state.editingId = null;
    state.selectedLatLng = L.latLng(lat, lng);

    els.dialogEyebrow.textContent = "NEW SIGHTING";
    els.dialogTitle.textContent = "Add this sticker";
    els.submitButton.textContent = "Add to the map";
    els.photoFieldWrap.hidden = false;
    els.photoInput.required = true;
    els.form.reset();
    els.dateInput.value = today();
    els.photoPreviewWrap.hidden = true;
    els.coordinateText.textContent = fromDevice
      ? `Using your device location: ${lat.toFixed(5)}, ${lng.toFixed(5)}.`
      : `Pinned at ${lat.toFixed(5)}, ${lng.toFixed(5)}.`;
    beginLocationLookup(lat, lng);
    openDialog();
  }

  function openEdit(spot) {
    state.mode = "edit";
    state.editingId = spot.id;
    state.selectedLatLng = L.latLng(Number(spot.lat), Number(spot.lng));

    els.dialogEyebrow.textContent = "EDIT SIGHTING";
    els.dialogTitle.textContent = "Edit this sticker";
    els.submitButton.textContent = "Save changes";
    els.photoFieldWrap.hidden = true;
    els.photoInput.required = false;
    els.formMessage.textContent = "";
    els.noteInput.value = spot.note || "";
    els.dateInput.value = spot.spotted_on || today();
    els.addedByInput.value = spot.added_by || "";
    els.coordinateText.textContent = `Pinned at ${Number(spot.lat).toFixed(5)}, ${Number(spot.lng).toFixed(5)}.`;

    els.photoPreview.src = spot.image_url;
    els.photoPreviewWrap.hidden = !spot.image_url;

    // Re-detect every time edit is opened. This lets older plots gain country data.
    beginLocationLookup(Number(spot.lat), Number(spot.lng));
    openDialog();
  }

  function openDialog() {
    els.formMessage.textContent = "";
    els.formMessage.classList.remove("success");
    els.submitButton.disabled = false;
    if (typeof els.dialog.showModal === "function") els.dialog.showModal();
    else els.dialog.setAttribute("open", "");
  }

  function closeDialog() {
    if (state.previewUrl) {
      URL.revokeObjectURL(state.previewUrl);
      state.previewUrl = null;
    }
    els.form.reset();
    els.photoPreviewWrap.hidden = true;
    els.photoPreview.removeAttribute("src");
    els.dateInput.value = today();
    state.selectedLatLng = null;
    state.location = null;
    state.locationLookupPromise = null;
    state.editingId = null;
    if (typeof els.dialog.close === "function") els.dialog.close();
    else els.dialog.removeAttribute("open");
  }

  els.closeDialog.addEventListener("click", closeDialog);
  els.cancelDialog.addEventListener("click", closeDialog);
  els.dialog.addEventListener("click", e => { if (e.target === els.dialog) closeDialog(); });

  els.photoInput.addEventListener("change", () => {
    const file = els.photoInput.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      els.formMessage.textContent = "Please choose an image file.";
      els.photoInput.value = "";
      return;
    }
    if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
    state.previewUrl = URL.createObjectURL(file);
    els.photoPreview.src = state.previewUrl;
    els.photoPreviewWrap.hidden = false;
  });

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Could not read that image.")); };
      img.src = url;
    });
  }

  async function imageToBlob(file, maxDimension = 1800, quality = 0.82) {
    const img = await loadImage(file);
    const scale = Math.min(1, maxDimension / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve, reject) => canvas.toBlob(
      blob => blob ? resolve(blob) : reject(new Error("Could not process image.")),
      "image/jpeg", quality
    ));
  }

  els.form.addEventListener("submit", async e => {
    e.preventDefault();
    const lat = Number(state.selectedLatLng?.lat);
    const lng = Number(state.selectedLatLng?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

    const addedBy = safeText(els.addedByInput.value, 80);
    if (!addedBy) {
      els.formMessage.textContent = "Please enter your name.";
      return;
    }

    const file = els.photoInput.files?.[0];
    if (state.mode === "add" && !file) {
      els.formMessage.textContent = "A photo is required.";
      return;
    }

    els.submitButton.disabled = true;
    els.submitButton.textContent = state.mode === "edit" ? "Saving…" : "Uploading…";

    try {
      const loc = state.locationLookupPromise ? await state.locationLookupPromise : state.location;
      const common = {
        place: loc?.place || `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
        country: loc?.country || null,
        country_code: loc?.countryCode || null,
        note: safeText(els.noteInput.value, 500) || null,
        spotted_on: els.dateInput.value || today(),
        added_by: addedBy
      };

      if (state.mode === "edit") {
        if (!live) throw new Error("Editing requires the live shared map.");

        const result = await db
          .from("spots")
          .update(common)
          .eq("id", state.editingId)
          .select("*")
          .single();

        if (result.error) throw result.error;
        replaceSpot(result.data);
        els.formMessage.textContent = "Updated!";
        els.formMessage.classList.add("success");
      } else {
        let imageUrl;
        if (live) {
          const compressed = await imageToBlob(file);
          const fileName = `${Date.now()}-${crypto.randomUUID()}.jpg`;
          const bucket = config.photoBucket || "sticker-photos";
          const upload = await db.storage.from(bucket).upload(fileName, compressed, {
            contentType: "image/jpeg", cacheControl: "31536000", upsert: false
          });
          if (upload.error) throw upload.error;
          imageUrl = db.storage.from(bucket).getPublicUrl(fileName).data.publicUrl;

          const result = await db.from("spots").insert({
            lat, lng, ...common, sticker_type: "nett_hier", image_url: imageUrl
          }).select("*").single();
          if (result.error) throw result.error;
          upsertSpot(result.data);
        } else {
          throw new Error("Connect Supabase before adding shared sightings.");
        }

        els.formMessage.textContent = "Added — it is live worldwide!";
        els.formMessage.classList.add("success");
      }

      setTimeout(() => {
        closeDialog();
        switchView("map");
        map.setView([lat, lng], Math.max(map.getZoom(), 11), { animate: true });
      }, 400);
    } catch (err) {
      console.error(err);
      els.formMessage.classList.remove("success");
      els.formMessage.textContent = err?.message || "Something went wrong.";
      els.submitButton.disabled = false;
      els.submitButton.textContent = state.mode === "edit" ? "Save changes" : "Add to the map";
    }
  });

  function formatDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return "Date not supplied";
    const [y,m,d] = value.split("-").map(Number);
    return new Intl.DateTimeFormat(undefined, { day:"numeric", month:"short", year:"numeric", timeZone:"UTC" })
      .format(new Date(Date.UTC(y,m-1,d)));
  }

  function buildPopup(spot) {
    const card = document.createElement("div");
    card.className = "popup-card";

    const img = document.createElement("img");
    img.src = spot.image_url;
    img.alt = spot.place ? `Sticker sighting in ${spot.place}` : "Sticker sighting";
    card.appendChild(img);

    const title = document.createElement("strong");
    title.textContent = spot.place || "Nett hier. spotted here";
    card.appendChild(title);

    const date = document.createElement("time");
    date.dateTime = spot.spotted_on || "";
    date.textContent = formatDate(spot.spotted_on);
    card.appendChild(date);

    if (spot.note) {
      const note = document.createElement("p");
      note.textContent = spot.note;
      card.appendChild(note);
    }

    const by = document.createElement("p");
    by.className = "popup-added-by";
    by.textContent = `Added by — ${spot.added_by || "Unknown"}`;
    card.appendChild(by);

    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "popup-edit-button";
    edit.textContent = "Edit sighting";
    edit.addEventListener("click", () => {
      map.closePopup();
      openEdit(spot);
    });
    card.appendChild(edit);

    return card;
  }

  function renderMarkers() {
    markerLayer.clearLayers();
    state.spots.forEach(spot => {
      const lat = Number(spot.lat), lng = Number(spot.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || !spot.image_url) return;
      const marker = L.marker([lat,lng], { icon: markerIcon });
      marker.bindPopup(buildPopup(spot), { maxWidth: 250, autoPanPadding: [24,24] });
      markerLayer.addLayer(marker);
    });
    updateCount();
    renderStats();
  }

  function upsertSpot(spot) {
    const i = state.spots.findIndex(s => s.id === spot.id);
    if (i >= 0) state.spots[i] = spot;
    else state.spots.unshift(spot);
    renderMarkers();
  }

  function replaceSpot(spot) { upsertSpot(spot); }

  function updateCount() { els.spotCount.textContent = String(state.spots.length); }

  function renderStats() {
    const counts = new Map();
    state.spots.forEach(spot => {
      const c = safeText(spot.country, 100);
      if (c) counts.set(c, (counts.get(c) || 0) + 1);
    });
    const ranking = [...counts.entries()].sort((a,b) => b[1]-a[1] || a[0].localeCompare(b[0]));
    els.statsTotal.textContent = String(state.spots.length);
    els.statsCountries.textContent = String(counts.size);
    els.statsTopCountry.textContent = ranking[0]?.[0] || "—";
    els.countryRanking.replaceChildren();

    if (!ranking.length) {
      const p = document.createElement("p");
      p.className = "empty-state";
      p.textContent = state.spots.length
        ? "Existing sightings have no country data yet. Open a pin and press Edit sighting, then Save changes."
        : "No sightings yet.";
      els.countryRanking.appendChild(p);
      return;
    }

    const max = ranking[0][1];
    ranking.forEach(([country,count]) => {
      const row = document.createElement("div"); row.className = "country-row";
      const name = document.createElement("div"); name.className = "country-name"; name.textContent = country;
      const track = document.createElement("div"); track.className = "country-bar-track";
      const bar = document.createElement("div"); bar.className = "country-bar"; bar.style.width = `${Math.max(3,count/max*100)}%`;
      const val = document.createElement("div"); val.className = "country-count"; val.textContent = String(count);
      track.appendChild(bar); row.append(name,track,val); els.countryRanking.appendChild(row);
    });
  }

  async function loadSpots() {
    if (!live) return setStatus("Demo mode");
    try {
      const result = await db.from("spots").select("*").order("created_at", { ascending:false }).limit(10000);
      if (result.error) throw result.error;
      state.spots = result.data || [];
      renderMarkers();
      setStatus("Live · shared worldwide", true);

      state.realtimeChannel = db.channel("nett-hier-live-spots")
        .on("postgres_changes", { event:"INSERT", schema:"public", table:"spots" }, p => p.new && upsertSpot(p.new))
        .on("postgres_changes", { event:"UPDATE", schema:"public", table:"spots" }, p => p.new && upsertSpot(p.new))
        .subscribe();
    } catch (err) {
      console.error(err);
      setStatus("Could not connect to shared map — check Supabase setup");
    }
  }

  addEventListener("pagehide", () => {
    if (db && state.realtimeChannel) db.removeChannel(state.realtimeChannel);
  });

  loadSpots();
})();

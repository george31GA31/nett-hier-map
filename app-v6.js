(() => {
  "use strict";

  const config = window.NETT_HIER_CONFIG || {};
  const key = String(config.supabasePublishableKey || config.supabaseAnonKey || "").trim();
  const live = Boolean(config.supabaseUrl && key && window.supabase);
  const db = live ? window.supabase.createClient(config.supabaseUrl, key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  }) : null;

  // Exactly 198 counted countries/territories:
  // 193 UN members + Vatican City + Palestine + Taiwan + Kosovo + Western Sahara.
  const VALID_COUNTRY_CODES = new Set(`
    AF AL DZ AD AO AG AR AM AU AT AZ BS BH BD BB BY BE BZ BJ BT BO BA BW BR BN BG BF BI CV KH CM CA CF TD CL CN CO KM CG CD CR CI HR CU CY CZ DK DJ DM DO EC EG SV GQ ER EE SZ ET FJ FI FR GA GM GE DE GH GR GD GT GN GW GY HT HN HU IS IN ID IR IQ IE IL IT JM JP JO KZ KE KI KP KR KW KG LA LV LB LS LR LY LI LT LU MG MW MY MV ML MT MH MR MU MX FM MD MC MN ME MA MZ MM NA NR NP NL NZ NI NE NG MK NO OM PK PW PA PG PY PE PH PL PT QA RO RU RW KN LC VC WS SM ST SA SN RS SC SL SG SK SI SB SO ZA SS ES LK SD SR SE CH SY TJ TZ TH TL TG TO TT TN TR TM TV UG UA AE GB US UY UZ VU VE VN YE ZM ZW VA PS TW XK EH
  `.trim().split(/\s+/));

  const REPORT_REASONS = new Set([
    "Not there anymore",
    "Wrong location",
    "Wrong variation of the Nett Hier / Not Bad sticker",
    "Inappropriate",
    "Too damaged",
    "Other"
  ]);

  const LOCAL_REPORTER_KEY = "nett-hier-reporter-token-v1";
  const LOCAL_CREATED_SPOTS_KEY = "nett-hier-created-spots-v1";
  const MAX_SOURCE_IMAGE_BYTES = 20 * 1024 * 1024;

  const state = {
    mode: "add",
    editingId: null,
    reportingSpotId: null,
    adding: false,
    selectedLatLng: null,
    location: null,
    locationLookupPromise: null,
    spots: [],
    previewUrl: null,
    realtimeChannel: null,
    authSubscription: null,
    user: null,
    geocodeCache: new Map(),
    localCreatedSpotIds: loadLocalCreatedSpotIds(),
    reporterToken: getOrCreateReporterToken()
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    brandHome: $("brandHome"),
    tabButtons: [...document.querySelectorAll(".tab-button")],
    mapView: $("mapView"), statsView: $("statsView"), stickersView: $("stickersView"),
    mapShell: document.querySelector(".map-shell"),
    spotCount: $("spotCount"), addButton: $("addButton"), myLocationButton: $("myLocationButton"),
    accountButton: $("accountButton"),
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
    formMessage: $("formMessage"), submitButton: $("submitButton"),
    accountDialog: $("accountDialog"), closeAccountDialog: $("closeAccountDialog"),
    accountForm: $("accountForm"), accountFields: $("accountFields"),
    accountEmail: $("accountEmail"), accountPassword: $("accountPassword"),
    signInButton: $("signInButton"), signUpButton: $("signUpButton"),
    accountMessage: $("accountMessage"), signedInPanel: $("signedInPanel"),
    signedInEmail: $("signedInEmail"), signOutButton: $("signOutButton"),
    reportDialog: $("reportDialog"), reportForm: $("reportForm"), closeReportDialog: $("closeReportDialog"),
    cancelReport: $("cancelReport"), reportReason: $("reportReason"), otherReportField: $("otherReportField"),
    reportComment: $("reportComment"), reportMessage: $("reportMessage"), submitReport: $("submitReport")
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

  function safeText(v, max) { return String(v || "").trim().slice(0, max); }

  function getOrCreateReporterToken() {
    try {
      const existing = localStorage.getItem(LOCAL_REPORTER_KEY);
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(existing || "")) {
        return existing;
      }
      const value = crypto.randomUUID();
      localStorage.setItem(LOCAL_REPORTER_KEY, value);
      return value;
    } catch {
      return crypto.randomUUID();
    }
  }

  function loadLocalCreatedSpotIds() {
    try {
      const parsed = JSON.parse(localStorage.getItem(LOCAL_CREATED_SPOTS_KEY) || "[]");
      return new Set(Array.isArray(parsed) ? parsed.filter(v => typeof v === "string").slice(-500) : []);
    } catch {
      return new Set();
    }
  }

  function rememberLocallyCreatedSpot(id) {
    if (!id) return;
    state.localCreatedSpotIds.add(id);
    try {
      localStorage.setItem(LOCAL_CREATED_SPOTS_KEY, JSON.stringify([...state.localCreatedSpotIds].slice(-500)));
    } catch {}
  }

  function forgetLocallyCreatedSpot(id) {
    state.localCreatedSpotIds.delete(id);
    try {
      localStorage.setItem(LOCAL_CREATED_SPOTS_KEY, JSON.stringify([...state.localCreatedSpotIds].slice(-500)));
    } catch {}
  }

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

  function normalizeCountryCode(value) {
    const code = safeText(value, 3).toUpperCase();
    return VALID_COUNTRY_CODES.has(code) ? code : null;
  }

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
    const countryCode = normalizeCountryCode(a.country_code);
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

  function signedInUserId() {
    return state.user?.id && !state.user.is_anonymous ? state.user.id : null;
  }

  function isOwnedByCurrentUser(spot) {
    const userId = signedInUserId();
    return Boolean(userId && spot?.owner_id && userId === spot.owner_id);
  }

  function openEdit(spot) {
    if (!isOwnedByCurrentUser(spot)) {
      setStatus("You can only edit sightings you added while signed in.");
      return;
    }

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
    if (file.size > MAX_SOURCE_IMAGE_BYTES) {
      els.formMessage.textContent = "That image is too large. Please choose one under 20 MB.";
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
    if (!ctx) throw new Error("Could not process image.");
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
    if (file && (!file.type.startsWith("image/") || file.size > MAX_SOURCE_IMAGE_BYTES)) {
      els.formMessage.textContent = "Please choose a valid image under 20 MB.";
      return;
    }

    els.submitButton.disabled = true;
    els.submitButton.textContent = state.mode === "edit" ? "Saving…" : "Uploading…";

    try {
      const loc = state.locationLookupPromise ? await state.locationLookupPromise : state.location;
      const common = {
        place: loc?.place || `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
        country: loc?.country || null,
        country_code: normalizeCountryCode(loc?.countryCode),
        note: safeText(els.noteInput.value, 500) || null,
        spotted_on: els.dateInput.value || today(),
        added_by: addedBy
      };

      if (state.mode === "edit") {
        if (!live) throw new Error("Editing requires the live shared map.");
        const spot = state.spots.find(s => s.id === state.editingId);
        if (!spot || !isOwnedByCurrentUser(spot)) throw new Error("You can only edit your own sightings.");

        const result = await db
          .from("spots")
          .update(common)
          .eq("id", state.editingId)
          .eq("owner_id", signedInUserId())
          .select("*")
          .single();

        if (result.error) throw result.error;
        replaceSpot(result.data);
        els.formMessage.textContent = "Updated!";
        els.formMessage.classList.add("success");
      } else {
        if (!live) throw new Error("Connect Supabase before adding shared sightings.");

        const compressed = await imageToBlob(file);
        if (compressed.size > 6 * 1024 * 1024) throw new Error("That image is still too large after processing.");
        const fileName = `${Date.now()}-${crypto.randomUUID()}.jpg`;
        const bucket = config.photoBucket || "sticker-photos";
        const upload = await db.storage.from(bucket).upload(fileName, compressed, {
          contentType: "image/jpeg", cacheControl: "31536000", upsert: false
        });
        if (upload.error) throw upload.error;
        const imageUrl = db.storage.from(bucket).getPublicUrl(fileName).data.publicUrl;

        const result = await db.from("spots").insert({
          lat, lng, ...common,
          sticker_type: "nett_hier",
          image_url: imageUrl,
          owner_id: signedInUserId()
        }).select("*").single();
        if (result.error) throw result.error;
        rememberLocallyCreatedSpot(result.data.id);
        upsertSpot(result.data);

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
      els.formMessage.textContent = friendlyError(err, "Something went wrong.");
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

  function friendlyError(err, fallback) {
    const message = String(err?.message || "");
    if (err?.code === "23505" || /duplicate key/i.test(message)) return "You have already reported this sighting.";
    if (/row-level security|permission denied/i.test(message)) return "You do not have permission to do that.";
    return safeText(message, 220) || fallback;
  }

  async function deleteSpot(spot) {
    if (!live || !isOwnedByCurrentUser(spot)) {
      setStatus("You can only delete sightings you added while signed in.");
      return;
    }
    if (!confirm("Delete this sighting? This cannot be undone.")) return;

    try {
      const result = await db
        .from("spots")
        .delete()
        .eq("id", spot.id)
        .eq("owner_id", signedInUserId())
        .select("id");
      if (result.error) throw result.error;
      if (!result.data?.length) throw new Error("You do not have permission to delete that sighting.");
      removeSpot(spot.id);
      forgetLocallyCreatedSpot(spot.id);
      map.closePopup();
      setStatus("Sighting deleted", true);
    } catch (err) {
      console.error(err);
      setStatus(friendlyError(err, "Could not delete that sighting."));
    }
  }

  function openReport(spot) {
    if (!spot?.id || isOwnedByCurrentUser(spot) || state.localCreatedSpotIds.has(spot.id)) return;
    state.reportingSpotId = spot.id;
    els.reportForm.reset();
    els.otherReportField.hidden = true;
    els.reportComment.required = false;
    els.reportMessage.textContent = "";
    els.reportMessage.classList.remove("success");
    els.submitReport.disabled = false;
    els.submitReport.textContent = "Submit report";
    if (typeof els.reportDialog.showModal === "function") els.reportDialog.showModal();
    else els.reportDialog.setAttribute("open", "");
  }

  function closeReportDialog() {
    state.reportingSpotId = null;
    els.reportForm.reset();
    els.otherReportField.hidden = true;
    els.reportMessage.textContent = "";
    if (typeof els.reportDialog.close === "function") els.reportDialog.close();
    else els.reportDialog.removeAttribute("open");
  }

  els.reportReason.addEventListener("change", () => {
    const other = els.reportReason.value === "Other";
    els.otherReportField.hidden = !other;
    els.reportComment.required = false;
    if (!other) els.reportComment.value = "";
  });
  els.closeReportDialog.addEventListener("click", closeReportDialog);
  els.cancelReport.addEventListener("click", closeReportDialog);
  els.reportDialog.addEventListener("click", e => { if (e.target === els.reportDialog) closeReportDialog(); });

  els.reportForm.addEventListener("submit", async e => {
    e.preventDefault();
    if (!live || !state.reportingSpotId) return;

    const reason = safeText(els.reportReason.value, 80);
    if (!REPORT_REASONS.has(reason)) {
      els.reportMessage.textContent = "Please choose a report reason.";
      return;
    }
    const comment = reason === "Other" ? (safeText(els.reportComment.value, 50) || null) : null;
    const spot = state.spots.find(s => s.id === state.reportingSpotId);
    if (!spot || isOwnedByCurrentUser(spot) || state.localCreatedSpotIds.has(spot.id)) {
      els.reportMessage.textContent = "You cannot report your own sighting.";
      return;
    }

    els.submitReport.disabled = true;
    els.submitReport.textContent = "Submitting…";

    try {
      const payload = {
        spot_id: spot.id,
        reason,
        comment,
        reporter_user_id: signedInUserId(),
        reporter_token: signedInUserId() ? null : state.reporterToken
      };
      const result = await db.from("spot_reports").insert(payload);
      if (result.error) throw result.error;
      els.reportMessage.textContent = "Report submitted. The sighting has not been changed.";
      els.reportMessage.classList.add("success");
      els.submitReport.textContent = "Submitted";
      setTimeout(closeReportDialog, 700);
    } catch (err) {
      console.error(err);
      els.reportMessage.classList.remove("success");
      els.reportMessage.textContent = friendlyError(err, "Could not submit that report.");
      els.submitReport.disabled = false;
      els.submitReport.textContent = "Submit report";
    }
  });

  function buildPopup(spot) {
    const card = document.createElement("div");
    card.className = "popup-card";

    const img = document.createElement("img");
    img.src = spot.image_url;
    img.alt = spot.place ? `Sticker sighting in ${spot.place}` : "Sticker sighting";
    img.loading = "lazy";
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

    if (isOwnedByCurrentUser(spot)) {
      const actions = document.createElement("div");
      actions.className = "popup-actions";

      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "popup-edit-button";
      edit.textContent = "Edit sighting";
      edit.addEventListener("click", () => {
        map.closePopup();
        openEdit(spot);
      });

      const del = document.createElement("button");
      del.type = "button";
      del.className = "popup-delete-button";
      del.textContent = "Delete";
      del.addEventListener("click", () => deleteSpot(spot));

      actions.append(edit, del);
      card.appendChild(actions);
    } else if (!state.localCreatedSpotIds.has(spot.id)) {
      const report = document.createElement("button");
      report.type = "button";
      report.className = "popup-report-button";
      report.textContent = "Report sighting";
      report.addEventListener("click", () => {
        map.closePopup();
        openReport(spot);
      });
      card.appendChild(report);
    }

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

  function removeSpot(id) {
    const before = state.spots.length;
    state.spots = state.spots.filter(s => s.id !== id);
    if (state.spots.length !== before) renderMarkers();
  }

  function updateCount() { els.spotCount.textContent = String(state.spots.length); }

  function renderStats() {
    const counts = new Map();
    state.spots.forEach(spot => {
      const code = normalizeCountryCode(spot.country_code);
      if (!code) return;
      const name = safeText(spot.country, 100) || code;
      const current = counts.get(code) || { name, count: 0 };
      current.count += 1;
      if (!current.name && name) current.name = name;
      counts.set(code, current);
    });

    const ranking = [...counts.values()].sort((a,b) => b.count-a.count || a.name.localeCompare(b.name));
    els.statsTotal.textContent = String(state.spots.length);
    els.statsCountries.textContent = String(counts.size);
    els.statsTopCountry.textContent = ranking[0]?.name || "—";
    els.countryRanking.replaceChildren();

    if (!ranking.length) {
      const p = document.createElement("p");
      p.className = "empty-state";
      p.textContent = state.spots.length
        ? "Existing sightings have no recognised country data yet."
        : "No sightings yet.";
      els.countryRanking.appendChild(p);
      return;
    }

    const max = ranking[0].count;
    ranking.forEach(({name,count}) => {
      const row = document.createElement("div"); row.className = "country-row";
      const countryName = document.createElement("div"); countryName.className = "country-name"; countryName.textContent = name;
      const track = document.createElement("div"); track.className = "country-bar-track";
      const bar = document.createElement("div"); bar.className = "country-bar"; bar.style.width = `${Math.max(3,count/max*100)}%`;
      const val = document.createElement("div"); val.className = "country-count"; val.textContent = String(count);
      track.appendChild(bar); row.append(countryName,track,val); els.countryRanking.appendChild(row);
    });
  }

  function openAccountDialog() {
    els.accountMessage.textContent = "";
    els.accountMessage.classList.remove("success");
    updateAccountUi();
    if (typeof els.accountDialog.showModal === "function") els.accountDialog.showModal();
    else els.accountDialog.setAttribute("open", "");
  }

  function closeAccountDialog() {
    els.accountForm.reset();
    els.accountMessage.textContent = "";
    if (typeof els.accountDialog.close === "function") els.accountDialog.close();
    else els.accountDialog.removeAttribute("open");
  }

  function updateAccountUi() {
    const signedIn = Boolean(state.user && !state.user.is_anonymous);
    els.accountButton.textContent = signedIn ? "Account" : "Sign in";
    els.accountFields.hidden = signedIn;
    els.signedInPanel.hidden = !signedIn;
    els.signedInEmail.textContent = signedIn ? safeText(state.user.email, 160) : "";
  }

  els.accountButton.addEventListener("click", openAccountDialog);
  els.closeAccountDialog.addEventListener("click", closeAccountDialog);
  els.accountDialog.addEventListener("click", e => { if (e.target === els.accountDialog) closeAccountDialog(); });

  async function signIn() {
    const email = safeText(els.accountEmail.value, 254).toLowerCase();
    const password = els.accountPassword.value;
    if (!email || !password) {
      els.accountMessage.textContent = "Enter your email and password.";
      return;
    }

    setAccountBusy(true, "Signing in…");
    try {
      const result = await db.auth.signInWithPassword({ email, password });
      if (result.error) throw result.error;
      els.accountMessage.textContent = "Signed in.";
      els.accountMessage.classList.add("success");
      setTimeout(closeAccountDialog, 350);
    } catch (err) {
      console.error(err);
      els.accountMessage.classList.remove("success");
      els.accountMessage.textContent = friendlyError(err, "Could not sign in.");
    } finally {
      setAccountBusy(false);
    }
  }

  async function signUp() {
    const email = safeText(els.accountEmail.value, 254).toLowerCase();
    const password = els.accountPassword.value;
    if (!email || password.length < 6) {
      els.accountMessage.textContent = "Use a valid email and a password of at least 6 characters.";
      return;
    }

    setAccountBusy(true, "Creating…");
    try {
      const result = await db.auth.signUp({ email, password });
      if (result.error) throw result.error;
      if (result.data?.session) {
        els.accountMessage.textContent = "Account created and signed in.";
        els.accountMessage.classList.add("success");
        setTimeout(closeAccountDialog, 450);
      } else {
        els.accountMessage.textContent = "Account created. Check your email to confirm it, then sign in.";
        els.accountMessage.classList.add("success");
      }
    } catch (err) {
      console.error(err);
      els.accountMessage.classList.remove("success");
      els.accountMessage.textContent = friendlyError(err, "Could not create that account.");
    } finally {
      setAccountBusy(false);
    }
  }

  function setAccountBusy(busy, signInText = "Sign in") {
    els.signInButton.disabled = busy;
    els.signUpButton.disabled = busy;
    els.signInButton.textContent = busy ? signInText : "Sign in";
  }

  els.accountForm.addEventListener("submit", e => {
    e.preventDefault();
    if (!live) return;
    signIn();
  });
  els.signUpButton.addEventListener("click", () => { if (live) signUp(); });
  els.signOutButton.addEventListener("click", async () => {
    if (!live) return;
    els.signOutButton.disabled = true;
    try {
      const result = await db.auth.signOut();
      if (result.error) throw result.error;
      closeAccountDialog();
    } catch (err) {
      console.error(err);
      els.accountMessage.textContent = friendlyError(err, "Could not sign out.");
    } finally {
      els.signOutButton.disabled = false;
    }
  });

  async function initAuth() {
    if (!live) {
      updateAccountUi();
      return;
    }
    try {
      const sessionResult = await db.auth.getSession();
      if (sessionResult.error) throw sessionResult.error;
      state.user = sessionResult.data.session?.user || null;
      updateAccountUi();
      renderMarkers();

      const authResult = db.auth.onAuthStateChange((_event, session) => {
        state.user = session?.user || null;
        updateAccountUi();
        renderMarkers();
      });
      state.authSubscription = authResult.data?.subscription || null;
    } catch (err) {
      console.error(err);
      state.user = null;
      updateAccountUi();
    }
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
        .on("postgres_changes", { event:"DELETE", schema:"public", table:"spots" }, p => p.old?.id && removeSpot(p.old.id))
        .subscribe();
    } catch (err) {
      console.error(err);
      setStatus("Could not connect to shared map — check Supabase setup");
    }
  }

  addEventListener("pagehide", () => {
    if (db && state.realtimeChannel) db.removeChannel(state.realtimeChannel);
    state.authSubscription?.unsubscribe?.();
  });

  Promise.all([initAuth(), loadSpots()]);
})();

(() => {
  "use strict";

  const config = window.NETT_HIER_CONFIG || {};
  const publishableKey =
    String(config.supabasePublishableKey || config.supabaseAnonKey || "").trim();

  const globalMode =
    Boolean(String(config.supabaseUrl || "").trim()) &&
    Boolean(publishableKey) &&
    !String(config.supabaseUrl).includes("YOUR_") &&
    !publishableKey.includes("YOUR_");

  const db =
    globalMode && window.supabase
      ? window.supabase.createClient(config.supabaseUrl, publishableKey, {
          auth: {
            persistSession: false,
            autoRefreshToken: false,
            detectSessionInUrl: false
          }
        })
      : null;

  const state = {
    adding: false,
    selectedLatLng: null,
    spots: [],
    spotIds: new Set(),
    previewUrl: null,
    realtimeChannel: null
  };

  const els = {
    mapShell: document.querySelector(".map-shell"),
    spotCount: document.getElementById("spotCount"),
    addButton: document.getElementById("addButton"),
    cancelAddMode: document.getElementById("cancelAddMode"),
    addModeNotice: document.getElementById("addModeNotice"),
    mapIntro: document.getElementById("mapIntro"),
    modeBadge: document.getElementById("modeBadge"),
    dialog: document.getElementById("sightingDialog"),
    form: document.getElementById("sightingForm"),
    closeDialog: document.getElementById("closeDialog"),
    cancelDialog: document.getElementById("cancelDialog"),
    coordinateText: document.getElementById("coordinateText"),
    photoInput: document.getElementById("photoInput"),
    photoPreviewWrap: document.getElementById("photoPreviewWrap"),
    photoPreview: document.getElementById("photoPreview"),
    placeInput: document.getElementById("placeInput"),
    dateInput: document.getElementById("dateInput"),
    noteInput: document.getElementById("noteInput"),
    formMessage: document.getElementById("formMessage"),
    submitButton: document.getElementById("submitButton")
  };

  if (!window.L) {
    els.modeBadge.textContent = "Map library failed to load — refresh the page";
    els.addButton.disabled = true;
    return;
  }

  const WORLD_BOUNDS = L.latLngBounds(
    L.latLng(-85.0511, -180),
    L.latLng(85.0511, 180)
  );

  const map = L.map("map", {
    minZoom: 2,
    maxZoom: 19,
    zoomControl: true,
    worldCopyJump: false,
    maxBounds: WORLD_BOUNDS,
    maxBoundsViscosity: 0.9,
    bounceAtZoomLimits: false
  }).setView([22, 7], 2);

  const tiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    minZoom: 2,
    maxZoom: 19,
    noWrap: true,
    bounds: WORLD_BOUNDS,
    updateWhenIdle: true,
    updateWhenZooming: false,
    keepBuffer: 2,
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);

  tiles.on("tileerror", () => {
    if (!els.modeBadge.classList.contains("live")) {
      els.modeBadge.textContent = "Some map tiles are slow to load — your sightings are still safe";
    }
  });

  const markerLayer = L.markerClusterGroup({
    showCoverageOnHover: false,
    maxClusterRadius: 45,
    spiderfyOnMaxZoom: true,
    removeOutsideVisibleBounds: true
  });
  map.addLayer(markerLayer);

  const markerIcon = L.divIcon({
    className: "",
    html: '<div class="nett-marker"><span>N</span></div>',
    iconSize: [31, 31],
    iconAnchor: [15, 30],
    popupAnchor: [0, -29]
  });

  const resizeMap = () => {
    window.requestAnimationFrame(() => map.invalidateSize({ pan: false }));
  };

  window.addEventListener("resize", resizeMap, { passive: true });
  window.addEventListener("orientationchange", () => setTimeout(resizeMap, 180), {
    passive: true
  });

  if (window.ResizeObserver) {
    const observer = new ResizeObserver(resizeMap);
    observer.observe(document.querySelector(".map-shell"));
  }

  setTimeout(resizeMap, 50);
  setTimeout(resizeMap, 350);

  function localDateValue() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  els.dateInput.value = localDateValue();

  function setStatus(text, live = false) {
    els.modeBadge.textContent = text;
    els.modeBadge.classList.toggle("live", live);
  }

  if (globalMode) {
    setStatus("Connecting to shared map…");
  } else {
    setStatus("Demo mode · connect Supabase to share sightings worldwide");
  }

  function setAdding(on) {
    state.adding = Boolean(on);
    els.mapShell.classList.toggle("adding", state.adding);
    els.addModeNotice.hidden = !state.adding;
    els.mapIntro.hidden = state.adding;
    els.addButton.setAttribute("aria-pressed", String(state.adding));
  }

  els.addButton.addEventListener("click", () => setAdding(!state.adding));
  els.cancelAddMode.addEventListener("click", () => setAdding(false));

  map.on("click", (event) => {
    if (!state.adding) return;
    state.selectedLatLng = event.latlng;
    setAdding(false);
    openDialog();
  });

  function openDialog() {
    const { lat, lng } = state.selectedLatLng;
    els.coordinateText.textContent =
      `Pinned at ${lat.toFixed(5)}, ${lng.toFixed(5)}.`;

    els.formMessage.textContent = "";
    els.formMessage.classList.remove("success");
    els.submitButton.disabled = false;
    els.submitButton.textContent = "Add to the map";

    if (typeof els.dialog.showModal === "function") {
      els.dialog.showModal();
    } else {
      els.dialog.setAttribute("open", "");
    }
  }

  function closeDialog() {
    if (state.previewUrl) {
      URL.revokeObjectURL(state.previewUrl);
      state.previewUrl = null;
    }

    els.photoPreviewWrap.hidden = true;
    els.photoPreview.removeAttribute("src");
    els.form.reset();
    els.dateInput.value = localDateValue();
    state.selectedLatLng = null;

    if (typeof els.dialog.close === "function") {
      els.dialog.close();
    } else {
      els.dialog.removeAttribute("open");
    }
  }

  els.closeDialog.addEventListener("click", closeDialog);
  els.cancelDialog.addEventListener("click", closeDialog);

  els.dialog.addEventListener("click", (event) => {
    if (event.target === els.dialog) closeDialog();
  });

  els.photoInput.addEventListener("change", () => {
    const file = els.photoInput.files && els.photoInput.files[0];

    if (!file) {
      els.photoPreviewWrap.hidden = true;
      return;
    }

    if (!file.type.startsWith("image/")) {
      els.formMessage.textContent = "Please choose an image file.";
      els.photoInput.value = "";
      return;
    }

    if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);

    state.previewUrl = URL.createObjectURL(file);
    els.photoPreview.src = state.previewUrl;
    els.photoPreviewWrap.hidden = false;
    els.formMessage.textContent = "";
  });

  async function imageToBlob(file, maxDimension = 1800, quality = 0.82) {
    const image = await loadImage(file);
    const scale = Math.min(1, maxDimension / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);

    return await new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("Could not process image."))),
        "image/jpeg",
        quality
      );
    });
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();

      image.onload = () => {
        URL.revokeObjectURL(url);
        resolve(image);
      };

      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("Could not read that image."));
      };

      image.src = url;
    });
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  function safeText(value, max) {
    return String(value || "").trim().slice(0, max);
  }

  function validateLatLng(lat, lng) {
    return (
      Number.isFinite(lat) &&
      Number.isFinite(lng) &&
      lat >= -90 &&
      lat <= 90 &&
      lng >= -180 &&
      lng <= 180
    );
  }

  els.form.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (!state.selectedLatLng) {
      els.formMessage.textContent = "Please choose a point on the map first.";
      return;
    }

    const file = els.photoInput.files && els.photoInput.files[0];

    if (!file) {
      els.formMessage.textContent = "A photo is required.";
      return;
    }

    if (file.size > 25 * 1024 * 1024) {
      els.formMessage.textContent = "That image is too large. Please choose one under 25 MB.";
      return;
    }

    const lat = Number(state.selectedLatLng.lat);
    const lng = Number(state.selectedLatLng.lng);

    if (!validateLatLng(lat, lng)) {
      els.formMessage.textContent = "That map position is invalid. Please pick the spot again.";
      return;
    }

    const place = safeText(els.placeInput.value, 120);
    const note = safeText(els.noteInput.value, 500);
    const spottedOn = els.dateInput.value || localDateValue();

    els.submitButton.disabled = true;
    els.submitButton.textContent = globalMode ? "Uploading…" : "Saving…";
    els.formMessage.textContent = "";

    try {
      let newSpot;

      if (globalMode) {
        const compressed = await imageToBlob(file);

        if (compressed.size > 6 * 1024 * 1024) {
          throw new Error("The compressed photo is still too large. Please choose a smaller image.");
        }

        const bucket = config.photoBucket || "sticker-photos";
        const fileName = `${Date.now()}-${crypto.randomUUID()}.jpg`;

        const uploadResult = await db.storage
          .from(bucket)
          .upload(fileName, compressed, {
            contentType: "image/jpeg",
            cacheControl: "31536000",
            upsert: false
          });

        if (uploadResult.error) throw uploadResult.error;

        const publicUrlResult = db.storage.from(bucket).getPublicUrl(fileName);
        const imageUrl = publicUrlResult.data.publicUrl;

        const row = {
          lat,
          lng,
          place: place || null,
          note: note || null,
          spotted_on: spottedOn,
          image_url: imageUrl
        };

        const insertResult = await db
          .from("spots")
          .insert(row)
          .select("id, lat, lng, place, note, spotted_on, image_url, created_at")
          .single();

        if (insertResult.error) {
          await db.storage.from(bucket).remove([fileName]).catch(() => {});
          throw insertResult.error;
        }

        newSpot = insertResult.data;
      } else {
        const compressed = await imageToBlob(file, 1000, 0.72);
        const imageUrl = await blobToDataUrl(compressed);

        newSpot = {
          id: crypto.randomUUID(),
          lat,
          lng,
          place: place || null,
          note: note || null,
          spotted_on: spottedOn,
          image_url: imageUrl,
          created_at: new Date().toISOString()
        };

        const current = readLocalSpots();
        current.unshift(newSpot);

        try {
          localStorage.setItem("nett-hier-spots-v2", JSON.stringify(current));
        } catch {
          throw new Error(
            "This browser has run out of demo storage. Connect Supabase for shared photo storage."
          );
        }
      }

      addSpotIfNew(newSpot);
      els.formMessage.textContent = globalMode ? "Added — it is live worldwide!" : "Added to this device.";
      els.formMessage.classList.add("success");

      const savedLatLng = [Number(newSpot.lat), Number(newSpot.lng)];

      setTimeout(() => {
        closeDialog();
        map.setView(savedLatLng, Math.max(map.getZoom(), 11), { animate: true });
      }, 450);
    } catch (error) {
      console.error(error);
      els.formMessage.classList.remove("success");
      els.formMessage.textContent =
        error && error.message
          ? error.message
          : "Something went wrong while saving this sighting.";
      els.submitButton.disabled = false;
      els.submitButton.textContent = "Add to the map";
    }
  });

  function readLocalSpots() {
    try {
      const parsed = JSON.parse(localStorage.getItem("nett-hier-spots-v2") || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function buildPopup(spot) {
    const card = document.createElement("div");
    card.className = "popup-card";

    const image = document.createElement("img");
    image.src = spot.image_url;
    image.alt = spot.place ? `Sticker sighting in ${spot.place}` : "Sticker sighting";
    image.loading = "lazy";
    card.appendChild(image);

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

    return card;
  }

  function formatDate(value) {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return "Date not supplied";
    }

    const [year, month, day] = value.split("-").map(Number);

    return new Intl.DateTimeFormat(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "UTC"
    }).format(new Date(Date.UTC(year, month - 1, day)));
  }

  function addMarker(spot) {
    const lat = Number(spot.lat);
    const lng = Number(spot.lng);

    if (!validateLatLng(lat, lng) || !spot.image_url) return;

    const marker = L.marker([lat, lng], { icon: markerIcon });
    marker.bindPopup(buildPopup(spot), {
      maxWidth: 250,
      autoPanPadding: [24, 24]
    });
    markerLayer.addLayer(marker);
  }

  function addSpotIfNew(spot) {
    const id = String(spot && spot.id ? spot.id : "");
    if (!id || state.spotIds.has(id)) return false;

    state.spotIds.add(id);
    state.spots.push(spot);
    addMarker(spot);
    updateCount();
    return true;
  }

  function renderSpots(spots) {
    markerLayer.clearLayers();
    state.spots = [];
    state.spotIds.clear();

    for (const spot of spots) {
      addSpotIfNew(spot);
    }

    updateCount();
  }

  function updateCount() {
    els.spotCount.textContent = String(state.spots.length);
  }

  function subscribeToLiveSpots() {
    if (!globalMode) return;

    state.realtimeChannel = db
      .channel("nett-hier-live-spots")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "spots"
        },
        (payload) => {
          if (payload && payload.new) {
            addSpotIfNew(payload.new);
          }
        }
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          setStatus("Live · shared worldwide", true);
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          setStatus("Shared map connected · live updates delayed", true);
        }
      });
  }

  async function loadSpots() {
    try {
      if (globalMode) {
        const result = await db
          .from("spots")
          .select("id, lat, lng, place, note, spotted_on, image_url, created_at")
          .order("created_at", { ascending: false })
          .limit(10000);

        if (result.error) throw result.error;

        renderSpots(result.data || []);
        setStatus("Live · shared worldwide", true);
        subscribeToLiveSpots();
      } else {
        renderSpots(readLocalSpots());
      }
    } catch (error) {
      console.error(error);

      if (globalMode) {
        setStatus("Could not connect to shared map — check Supabase setup");
      }
    }
  }

  window.addEventListener("pagehide", () => {
    if (db && state.realtimeChannel) {
      db.removeChannel(state.realtimeChannel);
    }
  });

  loadSpots();
})();

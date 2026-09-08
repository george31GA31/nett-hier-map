(() => {
  "use strict";

  const config = window.NETT_HIER_CONFIG || {};
  const globalMode =
    Boolean(config.supabaseUrl) &&
    Boolean(config.supabaseAnonKey) &&
    !String(config.supabaseUrl).includes("YOUR_") &&
    !String(config.supabaseAnonKey).includes("YOUR_");

  const db =
    globalMode && window.supabase
      ? window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey)
      : null;

  const state = {
    adding: false,
    selectedLatLng: null,
    spots: [],
    previewUrl: null
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

  const map = L.map("map", {
    worldCopyJump: true,
    minZoom: 2,
    zoomControl: true
  }).setView([23, 8], 2);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);

  const markerLayer = L.markerClusterGroup({
    showCoverageOnHover: false,
    maxClusterRadius: 45,
    spiderfyOnMaxZoom: true
  });
  map.addLayer(markerLayer);

  const markerIcon = L.divIcon({
    className: "",
    html: '<div class="nett-marker"><span>N</span></div>',
    iconSize: [30, 30],
    iconAnchor: [15, 29],
    popupAnchor: [0, -28]
  });

  function localDateValue() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  els.dateInput.value = localDateValue();

  els.modeBadge.textContent = globalMode
    ? "Live shared map"
    : "Demo mode · sightings save only on this device";

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
      `Pinned at ${lat.toFixed(5)}, ${lng.toFixed(5)} · drag/zoom the map first if you need a more exact spot.`;

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

  async function imageToBlob(file, maxDimension, quality) {
    const image = await loadImage(file);
    const scale = Math.min(1, maxDimension / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext("2d");
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

    if (file.size > 20 * 1024 * 1024) {
      els.formMessage.textContent = "That image is too large. Please choose one under 20 MB.";
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
      let imageUrl;
      let newSpot;

      if (globalMode) {
        const compressed = await imageToBlob(file, 1600, 0.84);
        const fileName = `${crypto.randomUUID()}.jpg`;
        const bucket = config.photoBucket || "sticker-photos";

        const uploadResult = await db.storage
          .from(bucket)
          .upload(fileName, compressed, {
            contentType: "image/jpeg",
            upsert: false
          });

        if (uploadResult.error) throw uploadResult.error;

        const publicUrlResult = db.storage.from(bucket).getPublicUrl(fileName);
        imageUrl = publicUrlResult.data.publicUrl;

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
          await db.storage.from(bucket).remove([fileName]);
          throw insertResult.error;
        }

        newSpot = insertResult.data;
      } else {
        const compressed = await imageToBlob(file, 950, 0.72);
        imageUrl = await blobToDataUrl(compressed);
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
          localStorage.setItem("nett-hier-spots-v1", JSON.stringify(current));
        } catch (err) {
          throw new Error(
            "This browser has run out of demo storage. Connect Supabase for proper photo storage."
          );
        }
      }

      state.spots.unshift(newSpot);
      addMarker(newSpot);
      updateCount();
      els.formMessage.textContent = "Added!";
      els.formMessage.classList.add("success");

      const savedLatLng = [newSpot.lat, newSpot.lng];
      setTimeout(() => {
        closeDialog();
        map.setView(savedLatLng, Math.max(map.getZoom(), 10), { animate: true });
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
      const parsed = JSON.parse(localStorage.getItem("nett-hier-spots-v1") || "[]");
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
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "Date not supplied";
    const [year, month, day] = value.split("-").map(Number);
    return new Intl.DateTimeFormat(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric"
    }).format(new Date(Date.UTC(year, month - 1, day)));
  }

  function addMarker(spot) {
    const marker = L.marker([spot.lat, spot.lng], { icon: markerIcon });
    marker.bindPopup(buildPopup(spot), { maxWidth: 240 });
    markerLayer.addLayer(marker);
  }

  function renderSpots() {
    markerLayer.clearLayers();
    for (const spot of state.spots) {
      if (validateLatLng(Number(spot.lat), Number(spot.lng)) && spot.image_url) {
        addMarker(spot);
      }
    }
    updateCount();
  }

  function updateCount() {
    els.spotCount.textContent = String(state.spots.length);
  }

  async function loadSpots() {
    try {
      if (globalMode) {
        const result = await db
          .from("spots")
          .select("id, lat, lng, place, note, spotted_on, image_url, created_at")
          .order("created_at", { ascending: false })
          .limit(5000);

        if (result.error) throw result.error;
        state.spots = result.data || [];
      } else {
        state.spots = readLocalSpots();
      }
      renderSpots();
    } catch (error) {
      console.error(error);
      els.modeBadge.textContent = globalMode
        ? "Could not load live sightings — check Supabase setup"
        : els.modeBadge.textContent;
    }
  }

  loadSpots();
})();

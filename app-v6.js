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

  const DUPLICATE_RADIUS_METRES = 1.5;
  const { distanceMetres, nearbyBounds, normalizeLongitude, ordinal } = window.NETT_HIER_UTILS;

  const state = {
    mode: "add",
    draftVersion: 0,
    checkingNearby: false,
    approvedNearbyIds: new Set(),
    duplicateConfirmation: null,
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
    reportComment: $("reportComment"), reportMessage: $("reportMessage"), submitReport: $("submitReport"),
    duplicateDialog: $("duplicateDialog"), closeDuplicateDialog: $("closeDuplicateDialog"),
    duplicatePhoto: $("duplicatePhoto"), duplicatePhotoUnavailable: $("duplicatePhotoUnavailable"),
    duplicatePlace: $("duplicatePlace"), duplicateDetails: $("duplicateDetails"), duplicatePosition: $("duplicatePosition"),
    duplicateSame: $("duplicateSame"), duplicateDifferent: $("duplicateDifferent")
  };

  if (!window.L) {
    els.modeBadge.textContent = "Map library failed to load — refresh the page";
    return;
  }

  const map = L.map("map", {
    minZoom: 2, maxZoom: 19, zoomControl: true, worldCopyJump: true
  }).setView([22, 7], 2);

  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    minZoom: 2, maxZoom: 19,
    updateWhenIdle: true, keepBuffer: 2,
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);

  // One marker per sighting at every zoom level, including overlapping positions.
  const markerLayer = L.layerGroup().addTo(map);
  const markerEntries = new Map();
  let markerRenderFrame = 0;
  let popupSelection = null;

  const markerIcon = L.divIcon({
    className: "nett-marker-icon",
    html: "",
    // The 20px pin sits inside a larger, invisible click target. Its tip is at [18,36].
    iconSize: [36,42], iconAnchor: [18,36]
  });
  const sightingPopup = L.popup({ maxWidth: 250, autoPanPadding: [24,24], offset: [0,-30] });
  sightingPopup.on("remove", () => {
    setSelectedMarker(popupSelection?.id, false);
    popupSelection = null;
    els.mapShell.classList.remove("sighting-open");
  });
  map.on("zoomend", () => {
    const entry = markerEntries.get(popupSelection?.id);
    if (entry) showSighting(entry.spot.id, overlappingSightingIds(entry));
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
        setAdding(false);
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
        if (state.selectedLatLng?.lat === lat && state.selectedLatLng?.lng === lng) {
          state.location = loc;
          els.detectedLocation.textContent = loc.place;
        }
        return loc;
      })
      .catch(err => {
        console.warn(err);
        const fallback = { place: `${lat.toFixed(5)}, ${lng.toFixed(5)}`, country: null, countryCode: null };
        if (state.selectedLatLng?.lat === lat && state.selectedLatLng?.lng === lng) {
          state.location = fallback;
          els.detectedLocation.textContent = "Location name unavailable — coordinates will be saved.";
        }
        return fallback;
      });
  }

  async function findNearbySpots(lat, lng) {
    let spots = state.spots;
    if (live) {
      // Query the shared data at plotting time, including pins outside the loaded map.
      const bounds = nearbyBounds(lat, lng, DUPLICATE_RADIUS_METRES);
      spots = [];
      for (let offset = 0; ; offset += 500) {
        let query = db.from("spots").select("*").gte("lat", bounds.south).lte("lat", bounds.north);
        if (bounds.west !== null) {
          query = bounds.west <= bounds.east
            ? query.gte("lng", bounds.west).lte("lng", bounds.east)
            : query.or(`lng.gte.${bounds.west},lng.lte.${bounds.east}`);
        }
        const result = await query.order("id").range(offset, offset + 499);
        if (result.error) throw result.error;
        spots.push(...(result.data || []));
        if ((result.data || []).length < 500) break;
      }
    }
    return spots.map(spot => ({ spot, distance: distanceMetres({ lat, lng }, spot) }))
      .filter(item => item.distance <= DUPLICATE_RADIUS_METRES + 1e-8)
      .sort((a, b) => a.distance - b.distance || String(a.spot.id).localeCompare(String(b.spot.id)));
  }

  function showDuplicateCandidate() {
    const pending = state.duplicateConfirmation;
    if (!pending) return;
    const { spot, distance } = pending.items[pending.index];
    els.duplicatePosition.textContent = `Sticker ${pending.index + 1} of ${pending.items.length} · ${distance.toFixed(1)} metres away`;
    els.duplicatePlace.textContent = spot.place || "Sticker sighting";
    els.duplicateDetails.textContent = `${formatDate(spot.spotted_on)} · Added by ${spot.added_by || "Unknown"}${spot.note ? ` · ${spot.note}` : ""}`;
    els.duplicatePhoto.hidden = !spot.image_url;
    els.duplicatePhotoUnavailable.hidden = Boolean(spot.image_url);
    if (spot.image_url) els.duplicatePhoto.src = spot.image_url;
    else els.duplicatePhoto.removeAttribute("src");
  }

  function finishDuplicateConfirmation(allow) {
    const pending = state.duplicateConfirmation;
    if (!pending) return;
    state.duplicateConfirmation = null;
    if (typeof els.duplicateDialog.close === "function") els.duplicateDialog.close();
    else els.duplicateDialog.removeAttribute("open");
    els.duplicatePhoto.removeAttribute("src");
    pending.resolve(allow);
  }

  function confirmNearbySpots(items) {
    const unchecked = items.filter(({ spot }) => !state.approvedNearbyIds.has(spot.id));
    if (!unchecked.length) return Promise.resolve(true);
    return new Promise(resolve => {
      state.duplicateConfirmation = { items: unchecked, index: 0, resolve };
      showDuplicateCandidate();
      if (typeof els.duplicateDialog.showModal === "function") els.duplicateDialog.showModal();
      else els.duplicateDialog.setAttribute("open", "");
      els.duplicateSame.focus();
    });
  }

  els.duplicatePhoto.addEventListener("error", () => {
    els.duplicatePhoto.hidden = true;
    els.duplicatePhotoUnavailable.hidden = false;
  });
  els.duplicateSame.addEventListener("click", () => finishDuplicateConfirmation(false));
  els.closeDuplicateDialog.addEventListener("click", () => finishDuplicateConfirmation(false));
  els.duplicateDialog.addEventListener("cancel", e => { e.preventDefault(); finishDuplicateConfirmation(false); });
  els.duplicateDialog.addEventListener("click", e => { if (e.target === els.duplicateDialog) finishDuplicateConfirmation(false); });
  els.duplicateDialog.addEventListener("close", () => { if (!els.duplicateDialog.open) finishDuplicateConfirmation(false); });
  els.duplicateDifferent.addEventListener("click", () => {
    const pending = state.duplicateConfirmation;
    if (!pending) return;
    state.approvedNearbyIds.add(pending.items[pending.index].spot.id);
    pending.index += 1;
    if (pending.index === pending.items.length) finishDuplicateConfirmation(true);
    else { showDuplicateCandidate(); els.duplicateSame.focus(); }
  });

  async function openAddAt(lat, lng, fromDevice) {
    if (state.checkingNearby || els.dialog.open || state.duplicateConfirmation) return;
    lng = normalizeLongitude(lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90) return;
    state.checkingNearby = true;
    state.approvedNearbyIds.clear();
    try {
      const nearby = await findNearbySpots(lat, lng);
      if (!await confirmNearbySpots(nearby)) return;
      prepareAddAt(lat, lng, fromDevice);
    } catch (err) {
      console.error(err);
      setStatus("Could not check nearby stickers. Please try plotting again.");
    } finally {
      state.checkingNearby = false;
    }
  }

  function prepareAddAt(lat, lng, fromDevice) {
    state.draftVersion += 1;
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

    state.draftVersion += 1;
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
    state.draftVersion += 1;
    finishDuplicateConfirmation(false);
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
    state.approvedNearbyIds.clear();
    if (typeof els.dialog.close === "function") els.dialog.close();
    else els.dialog.removeAttribute("open");
  }

  els.closeDialog.addEventListener("click", closeDialog);
  els.cancelDialog.addEventListener("click", closeDialog);
  els.dialog.addEventListener("click", e => { if (e.target === els.dialog) closeDialog(); });
  els.dialog.addEventListener("cancel", e => { e.preventDefault(); closeDialog(); });

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
    if (els.submitButton.disabled) return;
    const draftVersion = state.draftVersion;
    const submissionUserId = signedInUserId();
    const isCurrentDraft = () => state.draftVersion === draftVersion && els.dialog.open;
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
      if (state.mode === "add") {
        const nearby = await findNearbySpots(lat, lng);
        if (!isCurrentDraft()) return;
        if (!await confirmNearbySpots(nearby)) {
          if (isCurrentDraft()) closeDialog();
          return;
        }
      }
      const loc = state.locationLookupPromise ? await state.locationLookupPromise : state.location;
      if (!isCurrentDraft() || !state.selectedLatLng) return;
      if (signedInUserId() !== submissionUserId) throw new Error("Your account changed. Please submit again.");
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
        if (!isCurrentDraft()) return;
        els.formMessage.textContent = "Updated!";
        els.formMessage.classList.add("success");
      } else {
        if (!live) throw new Error("Connect Supabase before adding shared sightings.");

        const compressed = await imageToBlob(file);
        if (!isCurrentDraft()) return;
        if (signedInUserId() !== submissionUserId) throw new Error("Your account changed. Please submit again.");
        if (compressed.size > 6 * 1024 * 1024) throw new Error("That image is still too large after processing.");
        const fileName = `${Date.now()}-${crypto.randomUUID()}.jpg`;
        const bucket = config.photoBucket || "sticker-photos";
        const upload = await db.storage.from(bucket).upload(fileName, compressed, {
          contentType: "image/jpeg", cacheControl: "31536000", upsert: false
        });
        if (upload.error) throw upload.error;
        if (!isCurrentDraft()) return;
        if (signedInUserId() !== submissionUserId) throw new Error("Your account changed. Please submit again.");
        const imageUrl = db.storage.from(bucket).getPublicUrl(fileName).data.publicUrl;

        const result = await db.from("spots").insert({
          lat, lng, ...common,
          sticker_type: "nett_hier",
          image_url: imageUrl,
          owner_id: submissionUserId
        }).select("*").single();
        if (result.error) throw result.error;
        rememberLocallyCreatedSpot(result.data.id);
        upsertSpot(result.data);
        if (!isCurrentDraft()) return;

        els.formMessage.textContent = "Added — it is live worldwide!";
        els.formMessage.classList.add("success");
      }

      setTimeout(() => {
        if (!isCurrentDraft()) return;
        closeDialog();
        switchView("map");
        map.setView([lat, lng], Math.max(map.getZoom(), 11), { animate: true });
      }, 400);
    } catch (err) {
      console.error(err);
      if (!isCurrentDraft()) return;
      els.formMessage.classList.remove("success");
      els.formMessage.textContent = friendlyError(err, "Something went wrong.");
      els.submitButton.disabled = false;
      els.submitButton.textContent = state.mode === "edit" ? "Save changes" : "Add to the map";
    }
  });

  const sightingDateFormat = new Intl.DateTimeFormat(undefined, {
    day: "numeric", month: "short", year: "numeric", timeZone: "UTC"
  });
  function formatDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return "Date not supplied";
    const [y,m,d] = value.split("-").map(Number);
    return sightingDateFormat.format(new Date(Date.UTC(y,m-1,d)));
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

    if (spot.image_url) {
      const img = document.createElement("img");
      img.alt = spot.place ? `Sticker sighting in ${spot.place}` : "Sticker sighting";
      img.loading = "lazy";
      img.addEventListener("load", () => {
        if (sightingPopup.getContent() === card) sightingPopup.update();
      });
      img.src = spot.image_url;
      card.appendChild(img);
    }

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

  function markerPosition(spot) {
    if (spot.lat == null || spot.lng == null || String(spot.lat).trim() === "" || String(spot.lng).trim() === "") return null;
    const lat = Number(spot.lat), lng = Number(spot.lng);
    return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
      ? L.latLng(lat, lng) : null;
  }

  function updateMarkerLabel(entry) {
    const label = `Open sticker sighting: ${entry.spot.place || "Nett hier. spotted here"}`;
    entry.marker.options.title = label;
    const icon = entry.marker.getElement();
    if (icon) {
      icon.title = label;
      icon.setAttribute("aria-label", label);
    }
  }

  function setSelectedMarker(id, selected) {
    const marker = markerEntries.get(id)?.marker;
    if (!marker) return;
    marker.getElement()?.classList.toggle("is-selected", selected);
    marker.setZIndexOffset(selected ? 1000 : 0);
  }

  function overlappingSightingIds(entry) {
    const origin = map.latLngToLayerPoint(entry.marker.getLatLng());
    const ids = [entry.spot.id];
    const coarse = matchMedia("(pointer: coarse)").matches;
    // Compare screen-space targets, never change or spread stored coordinates.
    const width = coarse ? 44 : 36, height = coarse ? 50 : 42;
    markerEntries.forEach(other => {
      if (other === entry) return;
      const point = map.latLngToLayerPoint(other.marker.getLatLng());
      if (Math.abs(point.x - origin.x) < width && Math.abs(point.y - origin.y) < height) ids.push(other.spot.id);
    });
    return ids;
  }

  function showSighting(id, ids, focusControl) {
    const entry = markerEntries.get(id);
    if (!entry) return;
    ids = ids.filter(candidate => markerEntries.has(candidate));
    setSelectedMarker(popupSelection?.id, false);
    popupSelection = { id, ids };
    setSelectedMarker(id, true);
    els.mapShell.classList.add("sighting-open");

    // Build only the open popup, including its photo and current ownership actions.
    const card = buildPopup(entry.spot);
    if (ids.length > 1) {
      const navigation = document.createElement("div");
      navigation.className = "popup-sighting-navigation";
      const label = document.createElement("label");
      label.htmlFor = "nearbySighting";
      label.textContent = "Nearby sightings";
      const select = document.createElement("select");
      select.id = "nearbySighting";
      ids.forEach((candidate, index) => {
        const spot = markerEntries.get(candidate).spot;
        const option = document.createElement("option");
        option.value = candidate;
        option.textContent = `${index + 1}. ${spot.place || "Sticker sighting"} · ${formatDate(spot.spotted_on)} · ${spot.added_by || "Unknown"}`;
        select.appendChild(option);
      });
      select.value = id;
      select.addEventListener("change", () => showSighting(select.value, ids, "select"));

      const controls = document.createElement("div");
      controls.className = "popup-sighting-controls";
      const index = ids.indexOf(id);
      const position = document.createElement("span");
      position.setAttribute("role", "status");
      position.setAttribute("aria-live", "polite");
      position.textContent = `${index + 1} of ${ids.length}`;
      const previous = document.createElement("button");
      previous.type = "button";
      previous.textContent = "‹";
      previous.dataset.direction = "previous";
      previous.setAttribute("aria-label", "Previous nearby sighting");
      previous.addEventListener("click", () => showSighting(ids[(index - 1 + ids.length) % ids.length], ids, "previous"));
      const next = document.createElement("button");
      next.type = "button";
      next.textContent = "›";
      next.dataset.direction = "next";
      next.setAttribute("aria-label", "Next nearby sighting");
      next.addEventListener("click", () => showSighting(ids[(index + 1) % ids.length], ids, "next"));
      controls.append(previous, position, next);
      const hint = document.createElement("p");
      hint.textContent = "Zoom in to separate nearby pins. Sightings at the same spot can be browsed here.";
      navigation.append(label, select, controls, hint);
      card.prepend(navigation);
    }

    sightingPopup.options.maxHeight = Math.max(160, map.getSize().y - 90);
    sightingPopup.setLatLng(entry.marker.getLatLng()).setContent(card).openOn(map);
    if (focusControl) {
      const control = focusControl === "select" ? "select" : `[data-direction="${focusControl}"]`;
      card.querySelector(control)?.focus({ preventScroll: true });
    }
  }

  function refreshSightingPopup() {
    if (!popupSelection) return;
    const entry = markerEntries.get(popupSelection.id)
      || markerEntries.get(popupSelection.ids.find(id => markerEntries.has(id)));
    if (entry) showSighting(entry.spot.id, overlappingSightingIds(entry));
    else map.closePopup(sightingPopup);
  }

  function renderMarkers() {
    cancelAnimationFrame(markerRenderFrame);
    const retainedIds = new Set();
    const pending = [];
    state.spots.forEach(spot => {
      const position = markerPosition(spot);
      if (!spot.id || !position || retainedIds.has(spot.id)) return;
      retainedIds.add(spot.id);
      const entry = markerEntries.get(spot.id);
      if (entry) {
        const changed = entry.spot !== spot;
        entry.spot = spot;
        if (!entry.marker.getLatLng().equals(position, 0)) entry.marker.setLatLng(position);
        if (changed) updateMarkerLabel(entry);
      } else {
        pending.push({ spot, position });
      }
    });
    markerEntries.forEach((entry, id) => {
      if (retainedIds.has(id)) return;
      markerLayer.removeLayer(entry.marker);
      markerEntries.delete(id);
    });

    // Yield between small batches on the initial load. Existing pins keep their DOM
    // nodes, so realtime echoes, edits and sign-in changes do not redraw the map.
    let index = 0;
    function addBatch() {
      const started = performance.now();
      while (index < pending.length && performance.now() - started < 8) {
        const { spot, position } = pending[index++];
        const marker = L.marker(position, { icon: markerIcon, riseOnHover: true });
        const entry = { spot, marker };
        markerEntries.set(spot.id, entry);
        const open = () => showSighting(entry.spot.id, overlappingSightingIds(entry));
        marker.on("click", open);
        marker.on("keydown", event => {
          if (event.originalEvent?.key !== "Enter" && event.originalEvent?.key !== " ") return;
          L.DomEvent.stop(event.originalEvent);
          open();
        });
        markerLayer.addLayer(marker);
        updateMarkerLabel(entry);
      }
      markerRenderFrame = index < pending.length ? requestAnimationFrame(addBatch) : 0;
      if (!markerRenderFrame) refreshSightingPopup();
    }
    addBatch();
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
    let rank = 0;
    ranking.forEach(({name,count}, index) => {
      if (index === 0 || count !== ranking[index - 1].count) rank = index + 1;
      const row = document.createElement("div"); row.className = "country-row";
      const countryName = document.createElement("div"); countryName.className = "country-name";
      const position = document.createElement("span"); position.className = "country-rank"; position.textContent = ordinal(rank);
      const label = document.createElement("span"); label.className = "country-label"; label.textContent = name;
      countryName.title = `${ordinal(rank)} · ${name}`;
      countryName.append(position, label);
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

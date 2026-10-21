(() => {
  "use strict";

  const initialUrl = new URL(location.href);
  const initialHash = new URLSearchParams(initialUrl.hash.slice(1));
  const initialAuth = {type:initialHash.get("type")||initialUrl.searchParams.get("type"),error:initialHash.get("error_code")||initialHash.get("error")||initialUrl.searchParams.get("error_code")||initialUrl.searchParams.get("error"),hasToken:initialHash.has("access_token")||initialUrl.searchParams.has("code")};
  const config = window.NETT_HIER_CONFIG || {};
  const key = String(config.supabasePublishableKey || config.supabaseAnonKey || "").trim();
  const PRODUCTION_URL = "https://george31ga31.github.io/nett-hier-map/";
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
    stats: null,
    mapLoad: 0,
    backendConfig: null,
    recovery: false,
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
  const clusterLayer = L.layerGroup().addTo(map);
  const sightingPopup = L.popup({ maxWidth: 300, minWidth: 180, className: "sighting-popup", autoPanPadding: [16,16], offset: [0,-30] });
  sightingPopup.on("remove", () => {
    setSelectedMarker(popupSelection?.id, false);
    popupSelection = null;
    els.mapShell.classList.remove("sighting-open");
  });
  map.on("zoomend", () => {
    const entry = markerEntries.get(popupSelection?.id);
    if (entry) showSighting(entry.spot.id, overlappingSightingIds(entry));
  });
  let reloadTimer;
  map.on("moveend", () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(loadViewport, 200);
  });

  const resizeMap = () => requestAnimationFrame(() => {
    map.invalidateSize({ pan: false });
    sightingPopup.options.maxWidth = Math.min(300, Math.max(180, map.getSize().x - 56));
    sightingPopup.options.maxHeight = Math.max(120, map.getSize().y - 85);
    if (sightingPopup.isOpen()) sightingPopup.update();
  });
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

    const result = await api({action:"geocode",lat,lng});
    result.countryCode = normalizeCountryCode(result.countryCode);
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
    $("publicConsent").checked = false;
    $("publicConsentWrap").hidden = false;
    $("publicConsent").required = true;
    beginLocationLookup(lat, lng);
    openDialog();
    renderCaptcha("sightingCaptcha");
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

    $("publicConsentWrap").hidden = true;
    $("publicConsent").required = false;
    state.location = {place:spot.place,country:spot.country,countryCode:spot.country_code};
    state.locationLookupPromise = null;
    els.detectedLocation.textContent = spot.place || "Coordinates saved";
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
      els.formMessage.textContent = "Please enter a public nickname.";
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

        const saved = await api({action:"edit",id:state.editingId,lat,lng,...common});
        const result = {data:saved};
        replaceSpot(result.data);
        els.formMessage.textContent = "Updated!";
        els.formMessage.classList.add("success");
      } else {
        if (!live) throw new Error("Connect Supabase before adding shared sightings.");

        const compressed = await imageToBlob(file);
        if (compressed.size > 6 * 1024 * 1024) throw new Error("That image is still too large after processing.");
        if (!$("publicConsent").checked) throw new Error("Please confirm that you understand this sighting will be public.");
        const captchaToken = takeCaptcha("sightingCaptcha");
        const payload = {action:"sighting",requestId:crypto.randomUUID(),lat,lng,...common,captchaToken};
        const form = new FormData();
        form.set("payload",JSON.stringify(payload));
        form.set("photo",compressed,"sighting.jpg");
        const result = {data:await api(form)};
        rememberLocallyCreatedSpot(result.data.id);
        upsertSpot(result.data);
        loadStats();

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
      await api({action:"delete",id:spot.id});
      removeSpot(spot.id);
      forgetLocallyCreatedSpot(spot.id);
      map.closePopup();
      setStatus("Sighting deleted", true);
      loadStats();
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
    renderCaptcha("reportCaptcha");
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
      await api({action:"report",spot_id:spot.id,reason,comment,
        reporterToken:state.reporterToken,captchaToken:takeCaptcha("reportCaptcha")});
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

    const reference = document.createElement("small");
    reference.className="sighting-reference";reference.textContent=`Sighting ID: ${spot.id}`;
    card.append(reference);
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
    return ids.sort();
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
      select.addEventListener("change", event => {
        event.stopPropagation();
        showSighting(select.value, ids, "select");
      });

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
      previous.addEventListener("click", event => {
        event.preventDefault(); event.stopPropagation();
        showSighting(ids[(index - 1 + ids.length) % ids.length], ids, "previous");
      });
      const next = document.createElement("button");
      next.type = "button";
      next.textContent = "›";
      next.dataset.direction = "next";
      next.setAttribute("aria-label", "Next nearby sighting");
      next.addEventListener("click", event => {
        event.preventDefault(); event.stopPropagation();
        showSighting(ids[(index + 1) % ids.length], ids, "next");
      });
      controls.append(previous, position, next);
      const hint = document.createElement("p");
      hint.textContent = "Zoom in to separate nearby pins. Sightings at the same spot can be browsed here.";
      navigation.append(label, select, controls, hint);
      card.prepend(navigation);
    }

    // Stop the native event on this stable ancestor before replacing content.
    // Leaflet's _isClickDisabled walks parentNode; the old detached card no
    // longer reaches the popup container after setContent inside a click handler.
    L.DomEvent.disableClickPropagation(card);
    L.DomEvent.disableScrollPropagation(card);
    card.addEventListener("keydown", event => {
      if (event.target.tagName === "SELECT" || !["ArrowLeft","ArrowRight"].includes(event.key) || ids.length<2) return;
      event.preventDefault(); event.stopPropagation();
      const direction = event.key === "ArrowRight" ? 1 : -1;
      showSighting(ids[(ids.indexOf(id)+direction+ids.length)%ids.length],ids,direction>0?"next":"previous");
    });
    sightingPopup.options.maxWidth = Math.min(300, Math.max(180, map.getSize().x - 56));
    sightingPopup.options.maxHeight = Math.max(120, map.getSize().y - 85);
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

  function updateCount() { els.spotCount.textContent = state.stats ? String(state.stats.total) : "…"; }

  function renderStats() {
    if (!state.stats) return;
    const ranking = state.stats.countries.filter(c => normalizeCountryCode(c.code));
    els.statsTotal.textContent = String(state.stats.total);
    els.statsCountries.textContent = String(ranking.length);
    els.statsTopCountry.textContent = ranking[0]?.name || "—";
    els.countryRanking.replaceChildren();

    if (!ranking.length) {
      const p = document.createElement("p");
      p.className = "empty-state";
      p.textContent = state.stats.total
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
    els.accountFields.hidden = signedIn && !state.recovery;
    els.signedInPanel.hidden = !signedIn || state.recovery;
    $("accountHeading").textContent = state.recovery ? "Choose a new password" : (signedIn ? "Your account" : "Sign in");
    els.signInButton.textContent = state.recovery ? "Save password" : "Sign in";
    els.signUpButton.hidden = state.recovery;
    els.accountEmail.required = !state.recovery;
    els.accountEmail.closest("label").hidden = state.recovery;
    els.accountPassword.minLength = state.recovery ? 8 : 6;
    els.accountPassword.autocomplete = state.recovery ? "new-password" : "current-password";
    $("accountHelpActions").hidden = state.recovery;
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
    if (!email || password.length < 8) {
      els.accountMessage.textContent = "Use a valid email and a password of at least 8 characters.";
      return;
    }

    setAccountBusy(true, "Creating…");
    try {
      const result = await db.auth.signUp({ email, password, options:{emailRedirectTo:PRODUCTION_URL} });
      if (result.error) throw result.error;
      if (result.data?.session) {
        els.accountMessage.textContent = "Account created and signed in.";
        els.accountMessage.classList.add("success");
        setTimeout(closeAccountDialog, 450);
      } else {
        els.accountMessage.textContent = "Check your email to confirm your account. Older emails may still point to localhost; use “Resend confirmation” for a fresh link.";
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
    els.signInButton.textContent = busy ? signInText : (state.recovery ? "Save password" : "Sign in");
    $("resendConfirmation").disabled = busy;
    $("forgotPassword").disabled = busy;
  }

  els.accountForm.addEventListener("submit", e => {
    e.preventDefault();
    if (!live) return;
    if (state.recovery) savePassword(); else signIn();
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
      // Subscribe before getSession: recovery/confirmation events may occur
      // during the SDK's URL processing. Never await Auth APIs in this callback.
      const authResult = db.auth.onAuthStateChange((event, session) => {
        state.user = session?.user || null;
        if(event === "PASSWORD_RECOVERY") state.recovery = true;
        updateAccountUi();
        refreshSightingPopup();
        setTimeout(() => {
          refreshModerator();
          if(event === "PASSWORD_RECOVERY") {
            if(!els.accountDialog.open) openAccountDialog();
            els.accountMessage.textContent = "Your recovery link is valid. Choose a new password.";
          }
        },0);
      });
      const sessionResult = await db.auth.getSession();
      if (sessionResult.error) throw sessionResult.error;
      state.user = sessionResult.data.session?.user || null;
      updateAccountUi();
      await handleAuthReturn();
      state.authSubscription = authResult.data?.subscription || null;
    } catch (err) {
      console.error(err);
      state.user = null;
      updateAccountUi();
      if(initialAuth.error || initialAuth.hasToken || initialAuth.type === "recovery") {
        openAccountDialog();
        els.accountMessage.textContent="This email link is expired, invalid or has already been used. Enter your email and request a fresh confirmation or recovery link. Older localhost links must be resent.";
        history.replaceState(null,"",location.pathname);
      }
    }
  }

  async function api(body) {
    const session = await db.auth.getSession();
    const headers = {apikey:key};
    if(session.data.session?.access_token) headers.Authorization = `Bearer ${session.data.session.access_token}`;
    if(!(body instanceof FormData)) headers["Content-Type"] = "application/json";
    const response = await fetch(`${config.supabaseUrl}/functions/v1/public-api`,{
      method:"POST",headers,body:body instanceof FormData ? body : JSON.stringify(body),signal:AbortSignal.timeout(30000)
    });
    let result;
    try { result = await response.json(); } catch { throw new Error("The shared map service is unavailable. Please try again later."); }
    if(!response.ok) throw new Error(result.error || "The shared map service is unavailable. Please try again later.");
    return result;
  }

  const captchaWidgets = new Map();
  async function renderCaptcha(id) {
    const box = $(id); box.hidden = false;
    try {
      state.backendConfig ||= await api({action:"config"});
      if(!state.backendConfig.ready || !state.backendConfig.turnstileSiteKey) throw new Error("New submissions are being prepared. Please try again later.");
      if(!window.turnstile) {
        await new Promise((resolve,reject) => {
          const started=Date.now();
          const tick=()=>window.turnstile ? resolve() : Date.now()-started>10000 ? reject(new Error("Bot check could not load. Refresh the page and try again.")) : setTimeout(tick,100);
          tick();
        });
      }
      if(captchaWidgets.has(id)) window.turnstile.reset(captchaWidgets.get(id));
      else {box.replaceChildren();captchaWidgets.set(id,window.turnstile.render(box,{sitekey:state.backendConfig.turnstileSiteKey,action:"submission",size:"flexible"}));}
    } catch(error) { box.textContent=error.message; }
  }
  function takeCaptcha(id) {
    const widget = captchaWidgets.get(id);
    const token = widget != null && window.turnstile?.getResponse(widget);
    if(!token) throw new Error("Please complete the bot check before submitting.");
    // Tokens are single use; always refresh after an attempted submission.
    setTimeout(()=>window.turnstile?.reset(widget),0);
    return token;
  }

  async function handleAuthReturn() {
    const url=new URL(location.href);
    const hash=new URLSearchParams(url.hash.slice(1));
    const error=url.searchParams.get("error_code")||hash.get("error_code")||hash.get("error")||url.searchParams.get("error");
    const type=hash.get("type")||url.searchParams.get("type");
    const hadToken=hash.has("access_token")||url.searchParams.has("code")||type==="signup"||state.recovery;
    // Keep a recovery hint captured before the SDK clears its fragment.
    if(type==="recovery"||initialAuth.type==="recovery") state.recovery=Boolean(state.user);
    if(error||initialAuth.error) {
      openAccountDialog();
      els.accountMessage.textContent="This email link is expired, invalid or has already been used. Try signing in if you already confirmed, or enter your email and choose Resend confirmation. Older links may still point to localhost and must be resent.";
    } else if(hadToken||initialAuth.hasToken) {
      openAccountDialog();
      els.accountMessage.textContent = state.user
        ? (state.recovery ? "Choose a new password to complete recovery." : "Email confirmed — you are signed in.")
        : "We could not complete this link. Sign in or request a fresh confirmation email.";
      els.accountMessage.classList.toggle("success",!!state.user);
    }
    if(error||hadToken||initialAuth.hasToken||initialAuth.error) history.replaceState(null,"",url.pathname);
  }
  async function emailHelp(kind) {
    if(!live || !els.accountEmail.reportValidity()) return;
    setAccountBusy(true,"Sending…");
    try {
      const email=safeText(els.accountEmail.value,254).toLowerCase();
      const result=kind==="resend" ? await db.auth.resend({type:"signup",email,options:{emailRedirectTo:PRODUCTION_URL}})
        : await db.auth.resetPasswordForEmail(email,{redirectTo:PRODUCTION_URL});
      if(result.error) throw result.error;
      els.accountMessage.textContent = kind==="resend" ? "If confirmation is needed, a fresh email is on its way. Use the newest link; older localhost links will not work." : "If an account exists for this email, a password recovery link is on its way.";
      els.accountMessage.classList.add("success");
    } catch(error) {els.accountMessage.textContent=friendlyError(error,"Could not send that email.");}
    finally {setAccountBusy(false);}
  }
  async function savePassword() {
    if(els.accountPassword.value.length<8) {els.accountMessage.textContent="Use at least 8 characters.";return;}
    setAccountBusy(true,"Saving…");
    try {
      const {error}=await db.auth.updateUser({password:els.accountPassword.value});if(error)throw error;
      state.recovery=false;updateAccountUi();els.accountPassword.value="";
      els.accountMessage.textContent="Password updated. You are signed in.";els.accountMessage.classList.add("success");
    } catch(error) {els.accountMessage.textContent=friendlyError(error,"Could not update your password.");}
    finally {setAccountBusy(false);}
  }
  $("resendConfirmation").addEventListener("click",()=>emailHelp("resend"));
  $("forgotPassword").addEventListener("click",()=>emailHelp("recovery"));
  $("deleteAccount").addEventListener("click",async()=>{
    if(!confirm("Delete your account AND all sightings and photos added while signed in? Guest sightings cannot be linked to an account. This cannot be undone."))return;
    const button=$("deleteAccount");button.disabled=true;
    try {
      await api({action:"delete-account",confirm:"DELETE MY ACCOUNT"});
      await db.auth.signOut({scope:"local"});state.user=null;updateAccountUi();
      els.accountMessage.textContent="Your account and its public sightings have been deleted. Photos are queued for removal; cached copies may remain temporarily.";
      await loadViewport();await loadStats();
    }catch(error){els.accountMessage.textContent=error.message;}finally{button.disabled=false;}
  });
  async function refreshModerator() {
    $("moderationButton").hidden=true;
    if(!signedInUserId())return;
    try {const data=await api({action:"moderator"});$("moderationButton").hidden=!data.moderator;}catch{}
  }
  $("moderationButton").addEventListener("click",async()=>{if(!$("moderationDialog").open)$("moderationDialog").showModal();await loadModeration();});
  $("closeModeration").addEventListener("click",()=>$("moderationDialog").close());
  $("refreshModeration").addEventListener("click",loadModeration);
  async function loadModeration() {
    const list=$("moderationReports");list.replaceChildren();
    try {
      const data=await api({action:"moderate",operation:"list"});
      $("moderationStatus").textContent=`${data.openReports} open reports · ${(data.storageBytes/1048576).toFixed(1)} MB of ${(data.storageBudget/1048576).toFixed(0)} MB photo budget · ${data.cleanupPending} photos awaiting cleanup`;
      const pause=$("pauseSubmissions");pause.textContent=data.paused?"Resume submissions":"Pause submissions";
      pause.onclick=async()=>{try {await api({action:"moderate",operation:"pause",paused:!data.paused});await loadModeration();}catch(e){$("moderationStatus").textContent=e.message;}};
      for(const report of data.reports) {
        const card=document.createElement("article");card.className="moderation-report";
        const heading=document.createElement("strong");heading.textContent=`${report.reason} · ${report.place||report.spot_id}`;
        const note=document.createElement("p");note.textContent=report.comment||"";
        const img=document.createElement("img");img.src=report.image_url;img.alt="Reported sighting";img.loading="lazy";
        const view=document.createElement("button");view.type="button";view.textContent="View on map";view.className="secondary-button";
        view.onclick=()=>{$("moderationDialog").close();switchView("map");map.setView([report.lat,report.lng],17);};
        const resolve=document.createElement("button");resolve.type="button";resolve.textContent="Dismiss report";resolve.className="secondary-button";
        const remove=document.createElement("button");remove.type="button";remove.textContent="Remove sighting + photo";remove.className="popup-delete-button";
        const act=async(operation,target)=>{try{await api({action:"moderate",operation,target});await loadModeration();loadViewport();loadStats();}catch(e){$("moderationStatus").textContent=e.message;}};
        resolve.onclick=()=>act("resolve",report.id);
        remove.onclick=()=>{if(confirm("Remove this public sighting and its photo?"))act("remove",report.spot_id);};
        card.append(heading,note,img,view,resolve,remove);list.append(card);
      }
      for(const request of data.requests||[]) {
        const card=document.createElement("article");card.className="moderation-report";
        const title=document.createElement("strong");title.textContent="Private request";
        const text=document.createElement("p");text.textContent=request.message;
        const info=document.createElement("p");info.textContent=`Sighting: ${request.spot_id||"not supplied"} · Reply: ${request.reply_to||"not supplied"}`;
        const resolve=document.createElement("button");resolve.type="button";resolve.className="secondary-button";resolve.textContent="Mark handled";
        resolve.onclick=async()=>{try{await api({action:"moderate",operation:"resolve",target:request.id});await loadModeration();}catch(e){$("moderationStatus").textContent=e.message;}};
        card.append(title,text,info,resolve);list.append(card);
      }
      if(!data.reports.length&&!data.requests?.length)list.textContent="No open reports or private requests.";
    }catch(error){$("moderationStatus").textContent=error.message;}
  }

  async function loadStats() {
    try {
      const result=await db.rpc("nh_stats");if(result.error)throw result.error;
      state.stats=result.data;updateCount();renderStats();
    }catch(error){$("statsTotal").textContent="Unavailable";setStatus("Statistics unavailable — backend upgrade required");}
  }
  function viewportBounds() {
    const b=map.getBounds();const wrap=x=>((x+180)%360+360)%360-180;
    return {south:Math.max(-90,b.getSouth()),north:Math.min(90,b.getNorth()),west:b.getEast()-b.getWest()>=360?-180:wrap(b.getWest()),east:b.getEast()-b.getWest()>=360?180:wrap(b.getEast())};
  }
  async function loadViewport() {
    if(!live)return;
    const generation=++state.mapLoad;
    const b=viewportBounds();
    try {
      if(map.getZoom()<8) {
        const {data,error}=await db.rpc("nh_clusters",{...b,cell:360/2**map.getZoom()/5});if(error)throw error;
        if(generation!==state.mapLoad)return;
        state.spots=[];renderMarkers();clusterLayer.clearLayers();
        for(const cluster of data) {
          const icon=L.divIcon({className:"sighting-cluster",html:String(cluster.count),iconSize:[38,38]});
          L.marker([cluster.lat,cluster.lng],{icon,title:`${cluster.count} sightings — zoom in to see individual pins`})
            .on("click",event=>{L.DomEvent.stop(event.originalEvent);map.setView([cluster.lat,cluster.lng],Math.min(18,map.getZoom()+3),{animate:false});}).addTo(clusterLayer);
        }
        setStatus("Live · zoom in for individual sightings",true);
      }else {
        let after=null;const loaded=new Map();
        setStatus("Loading this map area…");
        do {
          const {data,error}=await db.rpc("nh_map_page",{...b,after_id:after});if(error)throw error;
          if(generation!==state.mapLoad)return;
          data.spots.forEach(spot=>loaded.set(spot.id,spot));
          after=data.next;
        }while(after);
        if(generation!==state.mapLoad)return;
        clusterLayer.clearLayers();state.spots=[...loaded.values()];renderMarkers();
        setStatus(`Live · ${loaded.size} sightings in this map area`,true);
      }
    }catch(error){if(generation===state.mapLoad)setStatus("Could not load map area — refresh to retry");console.error(error);}
  }
  async function loadSpots() {
    if(!live)return setStatus("Demo mode");
    await Promise.all([loadViewport(),loadStats()]);
    // Refresh only this viewport. Avoid broadcasting every photo/row into every
    // browser as the dataset grows. Poll also catches inserts outside this view.
    state.refreshInterval=setInterval(()=>{loadStats();if(!document.hidden&&!sightingPopup.isOpen())loadViewport();},60000);
  }

  addEventListener("pagehide", () => {
    clearInterval(state.refreshInterval);
    if (db && state.realtimeChannel) db.removeChannel(state.realtimeChannel);
    state.authSubscription?.unsubscribe?.();
  });

  Promise.all([initAuth(), loadSpots()]);
})();

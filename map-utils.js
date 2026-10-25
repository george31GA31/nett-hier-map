/* Shared, DOM-free map calculations. Distances are in metres. */
(() => {
  "use strict";
  const EARTH_RADIUS = 6371000;
  const radians = value => value * Math.PI / 180;
  const degrees = value => value * 180 / Math.PI;
  const normalizeLongitude = value => ((value + 180) % 360 + 360) % 360 - 180;

  function distanceMetres(a, b) {
    if ([a?.lat, a?.lng, b?.lat, b?.lng].some(value => value == null || value === "" || !Number.isFinite(Number(value)))) return Infinity;
    const lat1 = Number(a.lat), lat2 = Number(b.lat);
    if (Math.abs(lat1) > 90 || Math.abs(lat2) > 90) return Infinity;
    const dLat = radians(lat2 - lat1), dLng = radians(Number(b.lng) - Number(a.lng));
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_RADIUS * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
  }

  function nearbyBounds(lat, lng, radius) {
    const angular = radius / EARTH_RADIUS;
    const latitudeDelta = degrees(angular) + 1e-9;
    const south = Math.max(-90, lat - latitudeDelta), north = Math.min(90, lat + latitudeDelta);
    if (south === -90 || north === 90) return { south, north, west: null, east: null };
    const longitudeDelta = degrees(Math.asin(Math.min(1, Math.sin(angular) / Math.cos(radians(lat))))) + 1e-9;
    return { south, north, west: normalizeLongitude(lng - longitudeDelta), east: normalizeLongitude(lng + longitudeDelta) };
  }

  function ordinal(value) {
    const lastTwo = value % 100;
    const suffix = lastTwo >= 11 && lastTwo <= 13 ? "th" : ({ 1:"st", 2:"nd", 3:"rd" }[value % 10] || "th");
    return `${value}${suffix}`;
  }

  const api = { distanceMetres, nearbyBounds, normalizeLongitude, ordinal };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else window.NETT_HIER_UTILS = api;
})();

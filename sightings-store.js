(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.NETT_HIER_SIGHTINGS = api;
})(typeof window === "object" ? window : globalThis, function () {
  "use strict";

  function validateSnapshot(value, projectUrl) {
    if (value?.schemaVersion !== 1 || value.projectUrl !== projectUrl ||
        !Number.isFinite(Date.parse(value.syncedAt)) || !Array.isArray(value.spots)) {
      throw new Error("Invalid sightings backup");
    }
    const ids = new Set();
    for (const row of value.spots) {
      if (!row || typeof row.id !== "string" || !row.id || ids.has(row.id) ||
          typeof row.lat !== "number" || !Number.isFinite(row.lat) || Math.abs(row.lat) > 90 ||
          typeof row.lng !== "number" || !Number.isFinite(row.lng) || Math.abs(row.lng) > 180) {
        throw new Error("Invalid sighting in backup");
      }
      ids.add(row.id);
    }
    return value;
  }

  // Do not replace a working map with a partial or failed page of results.
  async function readAllSpots(readPage, pageSize = 500) {
    const rows = [];
    const ids = new Set();
    for (let offset = 0; ; offset += pageSize) {
      const result = await readPage(offset, offset + pageSize - 1);
      if (result.error) throw result.error;
      if (!Array.isArray(result.data)) throw new Error("Invalid shared sightings response");
      for (const row of result.data) {
        if (!row?.id || ids.has(row.id)) throw new Error("Sightings changed during loading; retrying");
        ids.add(row.id);
        rows.push(row);
      }
      if (result.data.length < pageSize) return rows;
    }
  }

  function cacheKey(projectUrl) { return `nett-hier-sightings-v1:${projectUrl}`; }
  function readCache(storage, projectUrl) {
    try { return validateSnapshot(JSON.parse(storage.getItem(cacheKey(projectUrl))), projectUrl); }
    catch { return null; }
  }
  function writeCache(storage, projectUrl, spots, syncedAt = new Date().toISOString()) {
    try { storage.setItem(cacheKey(projectUrl), JSON.stringify({schemaVersion: 1, projectUrl, syncedAt, spots})); }
    catch {} // Storage restrictions or quota must never break the map.
  }
  return {validateSnapshot, readAllSpots, readCache, writeCache};
});

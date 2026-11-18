const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readAllSpots, validateSnapshot, readCache, writeCache} = require('../sightings-store.js');
const projectUrl = 'https://example.supabase.co';
const snapshot = spots => ({schemaVersion: 1, projectUrl, syncedAt: '2026-11-18T12:00:00Z', spots});
const row = id => ({id: String(id), lat: 0, lng: 0});

test('loads every page past the normal API row limit', async () => {
  const rows = Array.from({length: 1251}, (_, i) => row(i));
  const calls = [];
  const loaded = await readAllSpots(async (start, end) => {
    calls.push([start, end]);
    return {data: rows.slice(start, end + 1)};
  });
  assert.deepEqual(loaded, rows);
  assert.equal(calls.length, 3);
});

test('a failed later page or repeated row rejects the complete refresh', async () => {
  await assert.rejects(readAllSpots(async start => start ? {error: new Error('Offline')} : {data: [row(1), row(2)]}, 2), /Offline/);
  await assert.rejects(readAllSpots(async () => ({data: [row(1)]}), 1), /changed during loading/);
  await assert.rejects(readAllSpots(async () => ({data: null})), /Invalid shared/);
  assert.deepEqual(await readAllSpots(async () => ({data: []})), []);
});

test('saved sightings survive failed refreshes and cache restrictions', () => {
  const entries = new Map();
  const storage = {getItem: key => entries.get(key), setItem: (key, value) => entries.set(key, value)};
  writeCache(storage, projectUrl, [row(1)], '2026-11-18T12:00:00Z');
  assert.deepEqual(readCache(storage, projectUrl), snapshot([row(1)]));
  assert.equal(readCache(storage, 'https://different.supabase.co'), null);
  const blocked = {getItem() {throw new Error('blocked');}, setItem() {throw new Error('quota');}};
  assert.equal(readCache(blocked, projectUrl), null);
  assert.doesNotThrow(() => writeCache(blocked, projectUrl, [row(1)]));
});

test('rejects damaged, mismatched or duplicate snapshots; accepts confirmed empty data', () => {
  assert.equal(validateSnapshot(snapshot([]), projectUrl).spots.length, 0);
  for (const bad of [null, {...snapshot([]), projectUrl: 'other'}, {...snapshot([]), syncedAt: 'broken'}, snapshot([row(1), row(1)]), snapshot([{...row(1), lat: null}]), snapshot([{...row(1), lng: 181}])]) {
    assert.throws(() => validateSnapshot(bad, projectUrl));
  }
});

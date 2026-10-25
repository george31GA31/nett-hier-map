const { test } = require('node:test');
const assert = require('node:assert/strict');
const { distanceMetres, nearbyBounds, normalizeLongitude, ordinal } = require('../map-utils.js');

test('ordinal ranks handle teens and later countries', () => {
  const expected = { 1:'1st', 2:'2nd', 3:'3rd', 4:'4th', 11:'11th', 12:'12th', 13:'13th', 21:'21st', 22:'22nd', 23:'23rd', 101:'101st', 111:'111th', 198:'198th' };
  for (const [value, text] of Object.entries(expected)) assert.equal(ordinal(Number(value)), text);
});

test('distance separates stickers inside and outside 1.5 metres', () => {
  const origin = { lat: 0, lng: 0 };
  const pointAt = metres => ({ lat: metres / 6371000 * 180 / Math.PI, lng: 0 });
  assert.equal(distanceMetres(origin, origin), 0);
  assert.ok(distanceMetres(origin, pointAt(1.49)) < 1.5);
  assert.ok(Math.abs(distanceMetres(origin, pointAt(1.5)) - 1.5) < 1e-8);
  assert.ok(distanceMetres(origin, pointAt(1.51)) > 1.5);
});

test('nearby query bounds contain every direction at multiple latitudes', () => {
  for (const lat of [0, 35, -70, 89.999999]) {
    const origin = { lat, lng: 179.999999 };
    const bounds = nearbyBounds(origin.lat, origin.lng, 1.5);
    const angle = 1.5 / 6371000, start = lat * Math.PI / 180;
    for (let bearing = 0; bearing < 360; bearing += 5) {
      const b = bearing * Math.PI / 180;
      const end = Math.asin(Math.sin(start) * Math.cos(angle) + Math.cos(start) * Math.sin(angle) * Math.cos(b));
      const delta = Math.atan2(Math.sin(b) * Math.sin(angle) * Math.cos(start), Math.cos(angle) - Math.sin(start) * Math.sin(end));
      const point = { lat: end * 180 / Math.PI, lng: normalizeLongitude(origin.lng + delta * 180 / Math.PI) };
      assert.ok(point.lat >= bounds.south && point.lat <= bounds.north, `latitude ${lat}, bearing ${bearing}`);
      if (bounds.west !== null) assert.ok(bounds.west <= bounds.east
        ? point.lng >= bounds.west && point.lng <= bounds.east
        : point.lng >= bounds.west || point.lng <= bounds.east);
    }
  }
});

test('distance and bounds handle the antimeridian, poles and invalid data', () => {
  assert.ok(distanceMetres({lat:0,lng:179.999999}, {lat:0,lng:-179.999999}) < 1.5);
  assert.ok(nearbyBounds(0, 179.999999, 1.5).west > nearbyBounds(0, 179.999999, 1.5).east);
  assert.equal(nearbyBounds(90, 0, 1.5).west, null);
  assert.equal(normalizeLongitude(181), -179);
  assert.equal(distanceMetres({lat:0,lng:0}, {lat:null,lng:0}), Infinity);
  assert.equal(distanceMetres({lat:0,lng:0}, {lat:100,lng:0}), Infinity);
});

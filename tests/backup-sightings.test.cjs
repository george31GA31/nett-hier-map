const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {fetchPublicSpots, refreshBackup} = require('../scripts/backup-sightings.cjs');
const config = {supabaseUrl: 'https://example.supabase.co', supabasePublishableKey: 'public-test-key'};
const spot = {id: '10000000-0000-4000-8000-000000000001', lat: 1, lng: 2, image_url: `${config.supabaseUrl}/storage/v1/object/public/sticker-photos/example.jpg`, owner_id: 'private', extra: 'not public'};
const rowsResponse = rows => new Response(JSON.stringify(rows), {headers: {'content-range': `0-${rows.length - 1}/${rows.length}`}});

test('public backup uses an explicit allowlist and rejects incomplete or failed responses', async () => {
  const rows = await fetchPublicSpots(config, async url => {
    assert(!url.searchParams.get('select').includes('owner_id'));
    return rowsResponse([spot]);
  });
  assert.equal(rows[0].owner_id, undefined);
  assert.equal(rows[0].extra, undefined);
  await assert.rejects(fetchPublicSpots(config, async () => new Response('[]', {headers: {'content-range': '*/2'}})), /Incomplete/);
  await assert.rejects(fetchPublicSpots(config, async () => new Response('Unavailable', {status: 503})), /503/);
  await assert.rejects(fetchPublicSpots(config, async () => new Response('[]')), /Missing/);
});

test('backup publishes complete photos, preserves the previous snapshot on failure, and honours deletions', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nett-hier-backup-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const manifest = path.join(root, 'data', 'sightings.json');
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  let photos = 0;
  const request = async url => {
    if (url.pathname.startsWith('/rest/')) return rowsResponse([spot]);
    photos++;
    return new Response(jpeg);
  };
  await refreshBackup({root, config, request});
  const saved = await fs.readFile(manifest, 'utf8');
  assert.equal(JSON.parse(saved).spots.length, 1);
  assert.deepEqual(await fs.readFile(path.join(root, 'data', 'photos', `${spot.id}.jpg`)), jpeg);
  await refreshBackup({root, config, request});
  assert.equal(photos, 1, 'unchanged photos are not downloaded again');
  const beforeFailure = await fs.readFile(manifest, 'utf8');
  await assert.rejects(refreshBackup({root, config, request: async () => new Response('down', {status: 503})}));
  assert.equal(await fs.readFile(manifest, 'utf8'), beforeFailure);
  await assert.rejects(refreshBackup({root, config, request: async url => url.pathname.startsWith('/rest/')
    ? rowsResponse([{...spot, image_url: spot.image_url + '?changed'}]) : new Response('not an image')}), /JPEG/);
  assert.equal(await fs.readFile(manifest, 'utf8'), beforeFailure);
  await refreshBackup({root, config, request: async () => rowsResponse([])});
  assert.deepEqual(JSON.parse(await fs.readFile(manifest, 'utf8')).spots, []);
});

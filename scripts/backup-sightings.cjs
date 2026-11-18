const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { validateSnapshot, readAllSpots } = require('../sightings-store.js');

// Only fields already displayed publicly. Accounts, owner IDs and reports are excluded.
const PUBLIC_FIELDS = 'id,lat,lng,place,country,country_code,sticker_type,note,spotted_on,image_url,created_at,added_by';

async function fetchPublicSpots(config, request = fetch) {
  let expectedCount;
  const spots = await readAllSpots(async (start, end) => {
    const url = new URL('/rest/v1/spots', config.supabaseUrl);
    url.search = new URLSearchParams({select: PUBLIC_FIELDS, order: 'id.asc', offset: start, limit: end - start + 1});
    const response = await request(url, {
      headers: {apikey: config.supabasePublishableKey, Prefer: 'count=exact'},
      signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) throw new Error(`Sightings request failed: HTTP ${response.status}`);
    const total = Number(response.headers.get('content-range')?.split('/')[1]);
    if (!Number.isSafeInteger(total) || total < 0) throw new Error('Missing sightings count');
    if (expectedCount !== undefined && total !== expectedCount) throw new Error('Sightings changed during backup');
    expectedCount = total;
    return {data: await response.json()};
  });
  if (spots.length !== expectedCount) throw new Error('Incomplete sightings backup');
  return spots.map(row => Object.fromEntries(PUBLIC_FIELDS.split(',').map(field => [field, row[field]])));
}

async function refreshBackup({root, config, request = fetch, now = () => new Date().toISOString()}) {
  const spots = await fetchPublicSpots(config, request);
  const snapshot = validateSnapshot({schemaVersion: 1, projectUrl: config.supabaseUrl, syncedAt: now(), spots}, config.supabaseUrl);
  const dataDir = path.join(root, 'data');
  const photosDir = path.join(dataDir, 'photos');
  await fs.mkdir(photosDir, {recursive: true});
  let previous;
  try { previous = validateSnapshot(JSON.parse(await fs.readFile(path.join(dataDir, 'sightings.json'), 'utf8')), config.supabaseUrl); } catch {}
  const previousById = new Map((previous?.spots || []).map(row => [row.id, row]));
  const pending = [...spots];
  await Promise.all(Array.from({length: 4}, async () => {
    while (pending.length) {
      const row = pending.shift();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.id)) throw new Error('Invalid photo ID');
      const photoPath = path.join(photosDir, `${row.id}.jpg`);
      if (previousById.get(row.id)?.image_url === row.image_url) {
        try { if ((await fs.stat(photoPath)).size > 0) continue; } catch {}
      }
      const imageUrl = new URL(row.image_url);
      if (imageUrl.origin !== new URL(config.supabaseUrl).origin ||
          !imageUrl.pathname.startsWith('/storage/v1/object/public/sticker-photos/')) {
        throw new Error('Unexpected public photo URL');
      }
      const response = await request(imageUrl, {signal: AbortSignal.timeout(30000), redirect: 'error'});
      if (!response.ok) throw new Error(`Photo request failed: HTTP ${response.status}`);
      if (Number(response.headers.get('content-length')) > 6 * 1024 * 1024) throw new Error('Photo exceeds bucket size');
      const image = Buffer.from(await response.arrayBuffer());
      if (image.length > 6 * 1024 * 1024 || image[0] !== 0xff || image[1] !== 0xd8) throw new Error('Invalid JPEG photo');
      await fs.writeFile(`${photoPath}.tmp`, image);
      await fs.rename(`${photoPath}.tmp`, photoPath);
    }
  }));
  // Publish the manifest only after every row and photo has been backed up.
  // Failures leave the last successful snapshot intact; a valid empty result is allowed.
  await fs.writeFile(path.join(dataDir, 'sightings.json.tmp'), `${JSON.stringify(snapshot, null, 2)}\n`);
  await fs.rename(path.join(dataDir, 'sightings.json.tmp'), path.join(dataDir, 'sightings.json'));
  return snapshot;
}

if (require.main === module) {
  (async () => {
    const root = path.resolve(__dirname, '..');
    const context = {window: {}};
    vm.runInNewContext(await fs.readFile(path.join(root, 'config.js'), 'utf8'), context);
    const snapshot = await refreshBackup({root, config: context.window.NETT_HIER_CONFIG});
    console.log(`Backed up ${snapshot.spots.length} public sightings and their photos at ${snapshot.syncedAt}`);
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = {fetchPublicSpots, refreshBackup};

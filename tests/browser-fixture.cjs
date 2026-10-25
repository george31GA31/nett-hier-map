const fs = require('node:fs');
const { expect } = require('playwright/test');
const ADMIN = '10000000-0000-4000-8000-000000000001';
const OWNER = '10000000-0000-4000-8000-000000000002';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAGElEQVR4nGP8/5+BJMBEmvJRDaMahpIGAEtNAh6ROTqFAAAAAElFTkSuQmCC', 'base64');
const spot = (id, extra = {}) => ({
  id, lat: 0, lng: 0, place: `Place ${id}`, country: 'Malta', country_code: 'MT',
  image_url: `https://ukkvukdzmdzpertbjjnp.supabase.co/storage/v1/object/public/sticker-photos/${id}.jpg`,
  added_by: 'Original author', owner_id: OWNER, note: 'Original note',
  spotted_on: '2026-10-01', created_at: '2026-10-01T00:00:00Z', ...extra
});

async function setup(page, options = {}) {
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  await page.route('https://cdn.jsdelivr.net/**', async route => {
    const url = route.request().url();
    if (url.includes('/leaflet@1.9.4/dist/leaflet.js')) {
      const js = fs.readFileSync(require.resolve('leaflet/dist/leaflet.js'), 'utf8');
      return route.fulfill({ contentType: 'text/javascript', body: `${js}\nconst makeMap=L.map; L.map=(...args)=>(window.__map=makeMap(...args));` });
    }
    if (url.includes('/leaflet@1.9.4/dist/leaflet.css')) return route.fulfill({ contentType: 'text/css', body: fs.readFileSync(require.resolve('leaflet/dist/leaflet.css'), 'utf8') });
    return route.fulfill({ contentType: 'text/javascript', body: '' });
  });
  await page.route('https://tile.openstreetmap.org/**', route => route.fulfill({ contentType: 'image/png', body: PNG }));
  await page.route('https://ukkvukdzmdzpertbjjnp.supabase.co/**', route => route.fulfill({ contentType: 'image/png', body: PNG }));
  await page.route('https://nominatim.openstreetmap.org/**', route => route.fulfill({ json: { address: { city: 'Moved location', country: 'Malta', country_code: 'mt' } } }));
  await page.addInitScript(({ options, ADMIN, OWNER }) => {
    const userFor = role => role ? { id: role === 'admin' ? ADMIN : OWNER, email: `${role}@example.com` } : null;
    const data = window.__test = {
      ...options,
      spots: options.spots || [],
      serverSpots: options.serverSpots || options.spots || [],
      reports: options.reports || [],
      user: userFor(options.role),
      adminEnabled: true,
      writes: [], reads: [], uploads: 0
    };
    const callbacks = [];
    data.switchUser = role => { data.user = userFor(role); callbacks.forEach(fn => fn('SIGNED_IN', data.user ? {user: data.user} : null)); };
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms || 0));
    class Query {
      constructor(table) { this.table = table; this.filters = []; this.orders = []; this.operation = 'select'; }
      select() { return this; }
      eq(field, value) { this.filters.push([field, 'eq', value]); return this; }
      gte(field, value) { this.filters.push([field, 'gte', value]); return this; }
      lte(field, value) { this.filters.push([field, 'lte', value]); return this; }
      or(value) { this.orFilter = value; return this; }
      order(field, opts = {}) { this.orders.push([field, opts.ascending !== false]); return this; }
      range(start, end) { this.rangeValue = [start, end]; return this; }
      limit(count) { this.rangeValue = [0, count - 1]; return this; }
      insert(payload) { this.operation = 'insert'; this.payload = payload; return this; }
      update(payload) { this.operation = 'update'; this.payload = payload; return this; }
      delete() { this.operation = 'delete'; return this; }
      single() { this.one = true; return this; }
      maybeSingle() { this.one = true; return this; }
      then(resolve, reject) { this.result ||= this.run(); return this.result.then(resolve, reject); }
      async run() {
        const near = this.table === 'spots' && this.filters.some(f => f[1] === 'gte');
        const source = this.table === 'spots' ? (near ? data.serverSpots : data.spots)
          : this.table === 'spot_reports' ? data.reports
          : data.user?.id === ADMIN && data.adminEnabled ? [{user_id: ADMIN}] : [];
        let rows = source.filter(row => this.filters.every(([field, op, value]) => op === 'eq' ? row[field] === value : op === 'gte' ? row[field] >= value : row[field] <= value));
        if (this.orFilter) {
          const [west, east] = this.orFilter.split(',').map(part => Number(part.split('.').slice(2).join('.')));
          rows = rows.filter(row => row.lng >= west || row.lng <= east);
        }
        if (this.operation === 'select') {
          data.reads.push({table: this.table, near});
          if (this.table === 'site_admins') await wait(data.adminDelay);
          if (this.table === 'spot_reports') await wait(data.feedbackDelay);
          if (near) await wait(data.nearbyDelay);
          if (near && data.nearbyError) return {data: null, error: {message: 'Network unavailable'}};
          for (const [field, ascending] of [...this.orders].reverse()) rows.sort((a,b) => String(a[field]).localeCompare(String(b[field])) * (ascending ? 1 : -1));
          if (this.rangeValue) rows = rows.slice(this.rangeValue[0], this.rangeValue[1] + 1);
          if (this.table === 'spot_reports') rows = rows.map(row => ({...row, spots: data.serverSpots.find(s => s.id === row.spot_id)}));
        } else {
          data.writes.push({table: this.table, operation: this.operation, payload: this.payload, filters: this.filters});
          if (this.operation === 'insert') {
            const row = {id: crypto.randomUUID(), status: 'open', reported_at: new Date().toISOString(), ...this.payload};
            source.push(row);
            rows = [row];
          } else if (this.operation === 'update') rows.forEach(row => Object.assign(row, this.payload));
          else rows.forEach(row => { const index = source.indexOf(row); if (index >= 0) source.splice(index, 1); });
        }
        rows = JSON.parse(JSON.stringify(rows));
        return { data: this.one ? rows[0] || null : rows, error: null };
      }
    }
    window.supabase = { createClient: () => ({
      from: table => new Query(table),
      auth: {
        getSession: async () => ({data: {session: data.user ? {user: data.user} : null}}),
        onAuthStateChange: fn => { callbacks.push(fn); return {data: {subscription: {unsubscribe(){}}}}; },
        signInWithPassword: async ({email}) => { data.switchUser(email.startsWith('admin') ? 'admin' : 'owner'); return {data: {user: data.user}}; },
        signOut: async () => { data.switchUser(null); return {}; }
      },
      storage: { from: () => ({
        upload: async () => { data.uploads++; return {}; },
        getPublicUrl: file => ({data: {publicUrl: `https://ukkvukdzmdzpertbjjnp.supabase.co/storage/v1/object/public/sticker-photos/${file}`}})
      }) },
      channel: () => ({on(){return this;}, subscribe(){return this;}}), removeChannel(){}
    }) };
  }, { options, ADMIN, OWNER });
  await page.goto('/');
  await expect(page.locator('#modeBadge')).toHaveText('Live · shared worldwide');
  return errors;
}

async function plotAt(page, lat = 0, lng = 0) {
  await page.locator('#addButton').click();
  await page.evaluate(({lat,lng}) => window.__map.fire('click', {latlng: L.latLng(lat,lng)}), {lat,lng});
}
async function openPin(page, lat = 0, lng = 0) {
  await page.evaluate(({lat,lng}) => {
    window.__map.eachLayer(layer => { if (layer instanceof L.Marker && layer.getLatLng().lat === lat && layer.getLatLng().lng === lng) layer.fire('click'); });
  }, {lat,lng});
  await expect(page.locator('.popup-card')).toBeVisible();
}
async function fillSighting(page) {
  await page.locator('#addedByInput').fill('Test visitor');
  await page.locator('#photoInput').setInputFiles({name: 'photo.png', mimeType: 'image/png', buffer: PNG});
}
module.exports = {setup, spot, plotAt, openPin, fillSighting, ADMIN, OWNER};

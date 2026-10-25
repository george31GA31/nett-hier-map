const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

const ADMIN = '10000000-0000-4000-8000-000000000001';
const OWNER = '10000000-0000-4000-8000-000000000002';
const OTHER = '10000000-0000-4000-8000-000000000003';
const OWN_SPOT = '20000000-0000-4000-8000-000000000001';
const OTHER_SPOT = '20000000-0000-4000-8000-000000000002';
const LEGACY_SPOT = '20000000-0000-4000-8000-000000000003';
const REPORT = '30000000-0000-4000-8000-000000000001';
const root = path.join(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20261025130732_admin_feedback_and_moderation.sql'), 'utf8');

test('admin permissions enforced by Postgres roles, column grants, RLS and triggers', async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated;
    create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
    alter table storage.objects enable row level security;
    create function storage.extension(name text) returns text language sql immutable as
      $$ select regexp_replace(name, '^.*\\.', '') $$;
    insert into auth.users (id) values ('${ADMIN}'), ('${OWNER}'), ('${OTHER}');
  `);
  // Storage and Auth are Supabase services. Load the repository's actual V6 schema
  // with only extension/publication provisioning omitted in the embedded engine.
  const base = fs.readFileSync(path.join(root, 'supabase.sql'), 'utf8')
    .replace('create extension if not exists pgcrypto;', '')
    .replace(/do \$\$[\s\S]*?end\n\$\$;/, '');
  await db.exec(base);
  await db.exec(fs.readFileSync(path.join(root, 'supabase_update_v6.sql'), 'utf8'));
  for (const [id, owner] of [[OWN_SPOT, OWNER], [OTHER_SPOT, OTHER], [LEGACY_SPOT, null]]) {
    await db.query(`insert into public.spots (id, lat, lng, place, country, country_code, added_by, image_url, owner_id)
      values ($1, 35, 14, 'Valletta, Malta', 'Malta', 'MT', $2, 'https://ukkvukdzmdzpertbjjnp.supabase.co/storage/v1/object/public/sticker-photos/test.jpg', $3)`,
      [id, owner ? 'Original author' : null, owner]);
  }
  await db.query(`insert into public.spot_reports (id, spot_id, reason, reporter_user_id) values ($1, $2, 'Wrong location', $3)`, [REPORT, LEGACY_SPOT, OWNER]);
  const before = (await db.query('select * from public.spots order by id')).rows;
  await db.exec(migration);
  await db.query('insert into public.site_admins (user_id) values ($1)', [ADMIN]);

  async function asRole(role, uid, sql, params = []) {
    await db.exec('begin');
    try {
      await db.exec(`set local role ${role}`);
      await db.query("select set_config('request.jwt.claim.sub', $1, true)", [uid || '']);
      return await db.query(sql, params);
    } finally { await db.exec('rollback'); }
  }
  const denied = { code: '42501' };

  await t.test('upgrade preserves every existing sighting and opens existing reports', async () => {
    assert.deepEqual((await db.query('select * from public.spots order by id')).rows, before);
    assert.equal((await db.query('select status from public.spot_reports')).rows[0].status, 'open');
    assert.equal((await asRole('anon', null, 'select id from public.spots')).rows.length, 3);
  });
  await t.test('membership is private and cannot be self-granted or deleted', async () => {
    assert.deepEqual((await asRole('authenticated', OWNER, 'select user_id from public.site_admins')).rows, []);
    assert.deepEqual((await asRole('authenticated', ADMIN, 'select user_id from public.site_admins')).rows, [{ user_id: ADMIN }]);
    await assert.rejects(asRole('anon', null, 'select user_id from public.site_admins'), denied);
    await assert.rejects(asRole('authenticated', OWNER, 'insert into public.site_admins (user_id) values ($1)', [OWNER]), denied);
    await assert.rejects(asRole('authenticated', ADMIN, 'delete from public.site_admins'), denied);
  });
  await t.test('owners retain metadata editing and deletion but cannot move pins', async () => {
    const updated = await asRole('authenticated', OWNER, "update public.spots set note = 'Updated note' where id = $1 returning note", [OWN_SPOT]);
    assert.equal(updated.rows[0].note, 'Updated note');
    assert.equal((await asRole('authenticated', OWNER, 'delete from public.spots where id = $1 returning id', [OWN_SPOT])).rows.length, 1);
    await assert.rejects(asRole('authenticated', OWNER, 'update public.spots set lat = 36 where id = $1', [OWN_SPOT]), denied);
    await assert.rejects(asRole('authenticated', OWNER, 'update public.spots set owner_id = $1 where id = $2', [OTHER, OWN_SPOT]), denied);
  });
  await t.test('ordinary users cannot edit or delete other or ownerless sightings', async () => {
    for (const id of [OTHER_SPOT, LEGACY_SPOT]) {
      assert.deepEqual((await asRole('authenticated', OWNER, "update public.spots set note = 'No' where id = $1 returning id", [id])).rows, []);
      assert.deepEqual((await asRole('authenticated', OWNER, 'delete from public.spots where id = $1 returning id', [id])).rows, []);
    }
  });
  await t.test('admins can move and delete any point while preserving its author and owner', async () => {
    for (const id of [OWN_SPOT, OTHER_SPOT, LEGACY_SPOT]) {
      const original = before.find(spot => spot.id === id);
      const moved = (await asRole('authenticated', ADMIN, "update public.spots set lat = 36, lng = 15, place = 'New location' where id = $1 returning *", [id])).rows[0];
      assert.equal(moved.lat, 36);
      assert.equal(moved.lng, 15);
      assert.equal(moved.owner_id, original.owner_id);
      assert.equal(moved.added_by, original.added_by);
      assert.equal(moved.image_url, original.image_url);
      assert.equal((await asRole('authenticated', ADMIN, 'delete from public.spots where id = $1 returning id', [id])).rows.length, 1);
    }
    await assert.rejects(asRole('authenticated', ADMIN, 'update public.spots set lat = 100 where id = $1', [LEGACY_SPOT]));
  });
  await t.test('reports are readable and resolvable only by admins', async () => {
    assert.deepEqual((await asRole('authenticated', OWNER, 'select * from public.spot_reports')).rows, []);
    await assert.rejects(asRole('anon', null, 'select * from public.spot_reports'), denied);
    assert.equal((await asRole('authenticated', ADMIN, 'select * from public.spot_reports')).rows.length, 1);
    assert.deepEqual((await asRole('authenticated', OWNER, "update public.spot_reports set status = 'resolved' where id = $1 returning id", [REPORT])).rows, []);
    assert.equal((await asRole('authenticated', ADMIN, "update public.spot_reports set status = 'resolved' where id = $1 returning status", [REPORT])).rows[0].status, 'resolved');
    await assert.rejects(asRole('authenticated', ADMIN, "update public.spot_reports set reason = 'Other' where id = $1", [REPORT]), denied);
    await assert.rejects(asRole('authenticated', ADMIN, "update public.spot_reports set status = 'anything' where id = $1", [REPORT]), { code: '23514' });
  });
  await t.test('signed-in and guest reporting still works without read access', async () => {
    await asRole('authenticated', OWNER, "insert into public.spot_reports (spot_id, reason, reporter_user_id) values ($1, 'Inappropriate', $2)", [OTHER_SPOT, OWNER]);
    await asRole('anon', null, "insert into public.spot_reports (spot_id, reason, reporter_token) values ($1, 'Too damaged', gen_random_uuid())", [OTHER_SPOT]);
    await assert.rejects(asRole('authenticated', OWNER, "insert into public.spot_reports (spot_id, reason, reporter_user_id, status) values ($1, 'Inappropriate', $2, 'resolved')", [OTHER_SPOT, OWNER]), denied);
    await assert.rejects(asRole('authenticated', OWNER, "insert into public.spot_reports (spot_id, reason, reporter_user_id) values ($1, 'Other', $2)", [OWN_SPOT, OWNER]), denied);
  });
  await t.test('revoking membership takes effect without refreshing the JWT', async () => {
    await db.exec('begin');
    try {
      await db.query('delete from public.site_admins where user_id = $1', [ADMIN]);
      await db.exec('set local role authenticated');
      await db.query("select set_config('request.jwt.claim.sub', $1, true)", [ADMIN]);
      assert.deepEqual((await db.query('select * from public.spot_reports')).rows, []);
      assert.deepEqual((await db.query('update public.spots set lat = 36 where id = $1 returning id', [LEGACY_SPOT])).rows, []);
    } finally { await db.exec('rollback'); }
  });
  await t.test('migration can be reapplied without changing sightings or duplicating admins', async () => {
    await db.exec(migration);
    assert.deepEqual((await db.query('select * from public.spots order by id')).rows, before);
    assert.equal((await db.query('select count(*)::int as count from public.site_admins')).rows[0].count, 1);
  });
});

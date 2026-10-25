# Nett hier. Sticker Map — V7

The existing map and sign-in screen now include nearby-sticker confirmation, country ranks and optional admin access.

## New features

- Plotting within **1.5 metres** of another sticker shows its actual photo, location, date and author. **It's the same** cancels the new sighting; **It's not the same** continues. If several stickers are nearby, each is checked.
- Nearby stickers are fetched from the shared database both when choosing a location and immediately before uploading. A failed check asks the visitor to retry. Legitimately separate stickers can still share a location.
- Stats show ordinal country ranks (1st, 2nd, 3rd, etc.). Equal counts share the same competition rank, with alphabetical ordering within a tie (for example, 1st, 1st, 3rd).
- An admin signs in through the same email/password form. Admins can edit, delete and move any point, including guest and pre-account sightings. **Move point** lets the admin choose a new map location and confirm it. Moving preserves the original author, owner, photo, date and note, and updates location/country metadata.
- Only admins see the additional **Feedback** tab. It lists submitted reports with the sighting's photo, reason, optional comment and report date. Admins can open the point on the map, resolve a report or reopen it. Existing reports become open reports on upgrade.
- Admin membership is stored in a server-managed table and checked by database RLS. It cannot be granted through the public website, user-editable metadata or browser settings. Ordinary users cannot move points or read reports.

## Existing behaviour

- The map still works for guests and all sightings remain publicly visible.
- Email/password accounts are optional.
- A sighting added while signed in is linked to that account with `owner_id`.
- Its owner and site admins can edit or delete it. Permissions are enforced by Supabase Row Level Security and column permissions, not just by the browser UI.
- Existing/pre-account sightings remain ownerless, visible and protected from ordinary editing/deletion.
- Guest-created sightings remain ownerless/protected. Sign in before plotting if you want future edit/delete control.
- Non-owned sightings can be reported for one of the six supported reasons. `Other` allows a maximum 50-character comment.
- Reports are stored in `spot_reports` and delivered to the admin's Feedback page. They do not automatically delete or alter a sighting, and are not sent by email.
- Duplicate reports for the same point are limited to one per signed-in account or one per browser guest token.
- Country statistics only recognise the agreed 198 codes: 193 UN member states plus Vatican City, Palestine, Taiwan, Kosovo and Western Sahara.
- Photo uploads remain public/free but are restricted to the existing JPEG bucket, 6 MB bucket limit and generated `.jpg` filename pattern.
- The browser uses the Supabase publishable key only; no privileged service key is exposed.

## Deploy / upgrade

For an existing V6 installation, apply `supabase/migrations/20261025130732_admin_feedback_and_moderation.sql` to the **Nett Hier** project (`ukkvukdzmdzpertbjjnp`) before deploying the updated frontend. The migration is transactional, preserves existing sightings/reports, and can be reapplied safely.

For a clean setup, apply `supabase.sql`, then `supabase_update_v6.sql`, then the new migration. Older upgrades remain in the root directory; they have not been moved into CLI migration history. Do not run `supabase db push` against an existing project without first baselining its migration history.

### Activate an admin account

1. Create a normal account on Nett Hier and confirm its email.
2. In the Nett Hier project's trusted SQL editor, replace the email below with that account's exact email and run it:

```sql
do $$
declare
  admin_user_id uuid;
begin
  select id into admin_user_id
  from auth.users
  where lower(email) = lower('REPLACE_WITH_ADMIN_EMAIL')
    and email_confirmed_at is not null;
  if admin_user_id is null then
    raise exception 'No confirmed account matches this email';
  end if;
  insert into public.site_admins (user_id)
  values (admin_user_id)
  on conflict (user_id) do nothing;
end;
$$;
```

3. Sign out and back in (or reload) to see Feedback and the extra map controls. There is no separate shared admin password or public admin-registration form.

To revoke admin access, delete that user's row from `public.site_admins` using trusted SQL. Database permissions take effect immediately, including for existing sessions; the interface refreshes its admin status on reload/sign-in/token refresh.

## Validation

```sh
npm ci
npm test
npx playwright install chromium
npm run test:browser
```

The Node tests exercise distance bounds, ordinal ranks, and the actual SQL migrations in embedded PostgreSQL (PGlite), including admin/owner/guest roles, report privacy, coordinate restrictions and immediate revocation. Browser tests use the real Leaflet map with isolated Supabase, geocoding, photo and tile fixtures; they never write to the live project.

## Important ownership behaviour

Older sightings deliberately have `owner_id = NULL`. They are not assigned to anyone retrospectively because there is no reliable way to prove who originally created them.

If an account is later deleted, its owned sightings are kept and become ownerless/protected rather than being deleted.

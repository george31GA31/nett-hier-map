# Nett hier. Sticker Map — V6.1

V6 keeps the existing map, styling and stored sightings, while adding optional accounts, secure ownership, reporting and database hardening.

## Nearby checks and country ranks

- Plotting within 1.5 metres of an existing sticker shows its photo and asks whether it is the same sticker. Each nearby sticker is checked separately.
- Choosing "It's the same" cancels; "It's not the same" continues. Shared data is checked again before uploading, and failed checks can be retried.
- Stats show ordinal country ranks, with competition ranks for ties (for example, 1st, 1st, 3rd).
- These features use the existing database and need no migration. Admin accounts, point moderation and the Feedback inbox are deferred to a separate change.

## Existing behaviour

- The map still works for guests and all sightings remain publicly visible.
- Email/password accounts are optional.
- A sighting added while signed in is linked to that account with `owner_id`.
- Only that owner can edit or delete it. Ownership is enforced by Supabase Row Level Security and column permissions, not just by the browser UI.
- Existing/pre-account sightings remain ownerless, visible and protected from ordinary editing/deletion.
- Guest-created sightings remain ownerless/protected. Sign in before plotting if you want future edit/delete control.
- Non-owned sightings can be reported for one of the six supported reasons. `Other` allows a maximum 50-character comment.
- Reports are stored in `spot_reports`; they do not delete or alter a sighting and are not emailed anywhere yet.
- Duplicate reports for the same point are limited to one per signed-in account or one per browser guest token.
- Country statistics only recognise the agreed 198 codes: 193 UN member states plus Vatican City, Palestine, Taiwan, Kosovo and Western Sahara.
- Photo uploads remain public/free but are restricted to the existing JPEG bucket, 6 MB bucket limit and generated `.jpg` filename pattern.
- The browser uses the Supabase publishable key only; no privileged service key is exposed.

## Deploy / upgrade

The live project needs the database migration in `supabase_update_v6.sql` applied once, then the V6 frontend files can be deployed.

For a clean Supabase setup, use the base `supabase.sql` and then apply `supabase_update_v6.sql`.

## Important ownership behaviour

Older sightings deliberately have `owner_id = NULL`. They are not assigned to anyone retrospectively because there is no reliable way to prove who originally created them.

If an account is later deleted, its owned sightings are kept and become ownerless/protected rather than being deleted.

## Validation

Run `npm ci` and `npm test` for the distance and ordinal checks. Run `npx playwright install chromium` followed by `npm run test:browser` for isolated Leaflet browser tests. The browser tests never write to the live project.

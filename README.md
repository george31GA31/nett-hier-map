# Nett hier. Sticker Map

An independent fan map documenting existing Nett hier / THE LÄND stickers. Existing sightings, photos, accounts and stable IDs are preserved by the public-launch work.

**Production rollout is not complete.** The implementation is on a review branch until the correct Supabase project is accessible and live acceptance checks pass. See [LAUNCH.md](LAUNCH.md) for the exact status, tested changes, required settings, rollout order and remaining verification.

## Development

```sh
npm ci
npm run check
npm run check:edge
npm test
npx playwright install chromium
npm run test:ui
```

Serve this folder with a static HTTP server for the frontend. The browser uses only the publishable key in `config.js`. Backend secrets belong in Supabase Edge settings or protected CI environments.

- `supabase/migrations/`: additive launch migration, based on the existing V6 schema.
- `supabase/functions/public-api/`: server-verified submissions, uploads, moderation, account deletion and shared geocoding.
- `ops/`: live audit, URL configuration, read-only orphan inventory, photo backup and monitoring tools.
- `.github/workflows/`: tests, encrypted separate database/photo backups and owner alerts. Operations/backups start disabled pending configuration.

New account deletion removes its owned public sightings and queues their photos for deletion. Older guest/legacy sightings remain protected and can be removed through the private contact route or owner moderation. Do not re-run historic setup SQL after the launch migration; it contains obsolete write policies.

# Nett hier. Sticker Map — V3

## New
- Automatic place/country lookup after tapping the map.
- Plot my location button using the device's current location.
- Stats tab with country ranking.
- Stickers tab with the current accepted sticker and an anti-vandalism disclaimer.
- Mobile/iPad layout retained.
- Live Supabase config already included.

## Before uploading V3
Run `supabase_update_v3.sql` once in Supabase SQL Editor.

## Then replace these GitHub files
`index.html`, `styles.css`, `app.js`, `config.js`, `favicon.svg`,
and `nett-hier-sticker.webp`.

The automatic place name uses OpenStreetMap Nominatim reverse geocoding.
If that lookup is temporarily unavailable, exact coordinates are still saved.

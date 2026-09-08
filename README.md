# Nett hier. Sticker Map — v2

This version fixes the map/page scrolling bug, improves phone/iPad behavior,
and is ready to be a genuinely shared worldwide map using Supabase.

## What changed

- The web page itself no longer scrolls underneath the map.
- The map is locked to the real world bounds, so there are no endless repeated worlds.
- Better map resizing after phone/iPad rotation and browser bar resizing.
- Responsive bottom-sheet style upload form on phones.
- 16px mobile inputs to stop iPhone/iPad Safari zooming into forms.
- Photos are compressed before upload.
- Live Supabase database + Storage support.
- Realtime INSERT subscription: a new sighting can appear on other open devices immediately.
- Sticker artwork is kept in the repository root, so GitHub web upload cannot break its path.

## Put this version on GitHub

Replace the old versions in the repo with:

- `index.html`
- `styles.css`
- `app.js`
- `config.js`
- `supabase.sql`
- `favicon.svg`
- `nett-hier-sticker.webp`

GitHub Pages can keep deploying from `main` and `/ (root)`.

## Make it worldwide instead of demo mode

1. Create a Supabase project.
2. Open **SQL Editor**.
3. Paste the complete contents of `supabase.sql`.
4. Run it.
5. Open the Supabase **Connect** dialog.
6. Copy:
   - Project URL
   - Publishable key (`sb_publishable_...`)
7. Edit `config.js` in GitHub and paste those two values.
8. Commit the change.

When the live page reloads, the bottom-right message should say:

`Live · shared worldwide`

Do NOT put a Supabase secret/service-role key in `config.js`.
The publishable key is the correct browser key; access is controlled by the
Row Level Security policies in `supabase.sql`.

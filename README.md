# Nett hier. Sticker Map

## Easiest way to open it

Double-click:

`Nett Hier Sticker Map - DOUBLE CLICK.html`

That version has the website design, code and sticker artwork bundled into one
file, so you do **not** need Terminal or a local web server. You still need an
internet connection for the world map tiles.

A deliberately simple public world map for sightings of the
“Nett hier. Aber waren Sie schon mal in Baden-Württemberg?” sticker.

## What already works

- World map with pan + zoom
- “Add a sighting” mode
- Click/tap the exact location
- Photo upload / phone camera
- Optional city/place and note
- Date spotted
- Yellow custom map pins
- Marker clustering when lots of sightings are close together
- Photo popups
- Mobile layout
- Automatic image resizing/compression
- Shared global database + photo storage when Supabase is connected
- Local demo mode when Supabase is not connected

## 1. Preview it immediately

The site can be previewed before you connect a database.

Recommended:

1. Open a terminal in this folder.
2. Run:
   `python -m http.server 8000`
3. Visit:
   `http://localhost:8000`

Without Supabase, the banner says **Demo mode**. New sightings are saved only in
that browser on that device.

## 2. Make it a real shared worldwide map

This build uses Supabase for the database and uploaded photos.

1. Create a Supabase project.
2. Open its **SQL Editor**.
3. Paste and run all of `supabase.sql`.
4. In Supabase, copy your **Project URL** and **publishable/anon key**.
5. Open `config.js` and fill in:

```js
window.NETT_HIER_CONFIG = {
  supabaseUrl: "https://YOUR-PROJECT.supabase.co",
  supabaseAnonKey: "YOUR-PUBLISHABLE-OR-ANON-KEY",
  photoBucket: "sticker-photos"
};
```

Reload the site. The bottom-right badge will change to **Live shared map**.

The browser key is designed to be public. Security comes from Supabase Row
Level Security; the supplied SQL allows public viewing and adding, but not
editing/deleting existing sightings.

## 3. Put it online

This is a static site, so after Supabase is connected you can deploy the folder
to any normal static host, including Netlify, Vercel, Cloudflare Pages or
GitHub Pages.

There is no separate server process to maintain.

## Files

- `index.html` — page structure
- `styles.css` — design
- `app.js` — map, marker, photo and saving logic
- `config.js` — Supabase connection details
- `supabase.sql` — database/storage setup
- `assets/nett-hier-sticker.webp` — supplied sticker artwork, resized for web
- `favicon.svg` — simple site icon

## Before a big public launch

The current MVP intentionally lets anyone submit a pin, because that is the
core idea. For a busy public site, the next useful additions would be:

- moderation / approve-before-publish
- CAPTCHA or rate limiting
- an admin delete/review screen
- duplicate reporting
- automatic place naming from coordinates
- shareable links to individual sightings

Those can be added without changing the basic map design.

# Nett hier. Sticker Map — V5

## New
- Every new sighting asks for **Added by**.
- Popups show `Added by — Name`.
- Every existing pin now has an **Edit sighting** button.
- Opening Edit automatically re-detects the location/country from its stored coordinates.
- Saving an old sighting therefore adds it into the country statistics.
- Date, note and added-by name can also be edited.
- Live updates now listen for both new sightings and edits.

## Upgrade steps

1. In Supabase → SQL Editor, run `supabase_update_v4.sql`.
2. It should say `Success. No rows returned`.
3. Replace the GitHub versions of:
   - `index.html`
   - `styles.css`
   - `app.js`
   - `config.js`
   - `favicon.svg`
   - `nett-hier-sticker.webp`
4. Commit and wait for GitHub Pages to deploy.
5. Hard refresh the site.

## Important editing note

There is no account/login system yet, so the Edit button is public. That means
any visitor can edit the metadata on any pin. Image deletion/replacement is not
enabled through the edit form.

A later version can restrict editing to an admin account or to the person who
created the sighting.


## V5 sticker rule
The Stickers tab now makes the rule explicit: only the yellow oval design in
the standard format counts, either with the German wording
“Nett hier. Aber waren Sie schon mal in Baden-Württemberg?” or the matching
English translation “Not bad. But have you ever been to Baden-Württemberg?”.

The supplied English example is included as `nett-hier-english.webp`.

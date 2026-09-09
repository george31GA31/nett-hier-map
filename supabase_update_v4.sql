-- Nett hier. Sticker Map — V4 upgrade
-- Run this ONCE in Supabase SQL Editor before uploading V4.

-- Name shown on each sighting.
alter table public.spots
  add column if not exists added_by text;

-- Allow the public browser app to update existing sighting metadata.
-- This is intentionally open because the site currently has no accounts/admin login.
grant update (
  place,
  country,
  country_code,
  sticker_type,
  note,
  spotted_on,
  added_by
) on table public.spots to anon, authenticated;

drop policy if exists "Anyone can edit spot metadata" on public.spots;
create policy "Anyone can edit spot metadata"
on public.spots
for update
to anon, authenticated
using (true)
with check (
  lat between -90 and 90
  and lng between -180 and 180
  and coalesce(char_length(place), 0) <= 120
  and coalesce(char_length(country), 0) <= 100
  and coalesce(char_length(country_code), 0) <= 3
  and coalesce(char_length(sticker_type), 0) <= 50
  and coalesce(char_length(note), 0) <= 500
  and coalesce(char_length(added_by), 0) <= 80
  and char_length(image_url) <= 2000
);

-- Make sure new inserts can include the name.
drop policy if exists "Anyone can add spots" on public.spots;
create policy "Anyone can add spots"
on public.spots
for insert
to anon, authenticated
with check (
  lat between -90 and 90
  and lng between -180 and 180
  and coalesce(char_length(place), 0) <= 120
  and coalesce(char_length(country), 0) <= 100
  and coalesce(char_length(country_code), 0) <= 3
  and coalesce(char_length(sticker_type), 0) <= 50
  and coalesce(char_length(note), 0) <= 500
  and coalesce(char_length(added_by), 0) <= 80
  and char_length(image_url) <= 2000
);

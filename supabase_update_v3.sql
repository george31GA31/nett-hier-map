-- Nett hier. Sticker Map — V3 upgrade
-- Run this once in Supabase SQL Editor BEFORE uploading the V3 website.

alter table public.spots add column if not exists country text;
alter table public.spots add column if not exists country_code text;
alter table public.spots add column if not exists sticker_type text not null default 'nett_hier';

create index if not exists spots_country_idx
  on public.spots (country);

grant select, insert on table public.spots to anon, authenticated;

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
  and char_length(image_url) <= 2000
);

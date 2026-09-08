-- Nett hier. Sticker Map — Supabase setup
-- Run this entire file in the Supabase SQL Editor.

create extension if not exists pgcrypto;

create table if not exists public.spots (
  id uuid primary key default gen_random_uuid(),
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  place text check (char_length(place) <= 120),
  note text check (char_length(note) <= 500),
  spotted_on date not null default current_date,
  image_url text not null,
  created_at timestamptz not null default now()
);

create index if not exists spots_created_at_idx
  on public.spots (created_at desc);

create index if not exists spots_spotted_on_idx
  on public.spots (spotted_on desc);

alter table public.spots enable row level security;

drop policy if exists "Anyone can view spots" on public.spots;
create policy "Anyone can view spots"
on public.spots
for select
to anon, authenticated
using (true);

drop policy if exists "Anyone can add spots" on public.spots;
create policy "Anyone can add spots"
on public.spots
for insert
to anon, authenticated
with check (
  lat between -90 and 90
  and lng between -180 and 180
  and coalesce(char_length(place), 0) <= 120
  and coalesce(char_length(note), 0) <= 500
  and char_length(image_url) <= 2000
);

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'sticker-photos',
  'sticker-photos',
  true,
  6291456,
  array['image/jpeg']
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Public can view sticker photos" on storage.objects;
create policy "Public can view sticker photos"
on storage.objects
for select
to public
using (bucket_id = 'sticker-photos');

drop policy if exists "Public can upload sticker photos" on storage.objects;
create policy "Public can upload sticker photos"
on storage.objects
for insert
to anon, authenticated
with check (bucket_id = 'sticker-photos');

-- No UPDATE or DELETE policy is created.
-- Public visitors can add and view sightings, but cannot edit or delete them.

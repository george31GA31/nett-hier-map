-- Nett hier. Sticker Map — Supabase LIVE setup
-- Run this entire file once in Supabase → SQL Editor.
--
-- This creates:
--   1) a public-readable sightings table
--   2) anonymous/public INSERT access
--   3) a public photo bucket
--   4) anonymous photo uploads
--   5) Realtime INSERT notifications so new pins appear on other devices immediately

create extension if not exists pgcrypto;

create table if not exists public.spots (
  id uuid primary key default gen_random_uuid(),
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  place text check (char_length(place) <= 120),
  note text check (char_length(note) <= 500),
  spotted_on date not null default current_date,
  image_url text not null check (char_length(image_url) <= 2000),
  created_at timestamptz not null default now()
);

create index if not exists spots_created_at_idx
  on public.spots (created_at desc);

create index if not exists spots_spotted_on_idx
  on public.spots (spotted_on desc);

-- Current Supabase API access is privilege + RLS based.
grant usage on schema public to anon, authenticated;
grant select, insert on table public.spots to anon, authenticated;

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

-- Public image bucket. Public means images can be viewed by anyone,
-- but uploads are still controlled by the INSERT policy below.
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

drop policy if exists "Anyone can upload sticker photos" on storage.objects;
create policy "Anyone can upload sticker photos"
on storage.objects
for insert
to anon, authenticated
with check (
  bucket_id = 'sticker-photos'
  and lower(storage.extension(name)) = 'jpg'
);

-- Public users are intentionally NOT given UPDATE or DELETE access.

-- Enable Realtime for new sightings.
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'spots'
  ) then
    alter publication supabase_realtime add table public.spots;
  end if;
end
$$;

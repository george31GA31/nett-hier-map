-- Nett hier. Sticker Map — current full setup

create extension if not exists pgcrypto;

create table if not exists public.spots (
  id uuid primary key default gen_random_uuid(),
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  place text check (char_length(place) <= 120),
  country text,
  country_code text,
  sticker_type text not null default 'nett_hier',
  note text check (char_length(note) <= 500),
  spotted_on date not null default current_date,
  image_url text not null check (char_length(image_url) <= 2000),
  created_at timestamptz not null default now()
);

alter table public.spots add column if not exists country text;
alter table public.spots add column if not exists country_code text;
alter table public.spots add column if not exists sticker_type text not null default 'nett_hier';

create index if not exists spots_created_at_idx on public.spots (created_at desc);
create index if not exists spots_spotted_on_idx on public.spots (spotted_on desc);
create index if not exists spots_country_idx on public.spots (country);

grant usage on schema public to anon, authenticated;
grant select, insert on table public.spots to anon, authenticated;

alter table public.spots enable row level security;

drop policy if exists "Anyone can view spots" on public.spots;
create policy "Anyone can view spots"
on public.spots for select to anon, authenticated using (true);

drop policy if exists "Anyone can add spots" on public.spots;
create policy "Anyone can add spots"
on public.spots for insert to anon, authenticated
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

insert into storage.buckets (
  id, name, public, file_size_limit, allowed_mime_types
)
values (
  'sticker-photos', 'sticker-photos', true, 6291456, array['image/jpeg']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Anyone can upload sticker photos" on storage.objects;
create policy "Anyone can upload sticker photos"
on storage.objects for insert to anon, authenticated
with check (
  bucket_id = 'sticker-photos'
  and lower(storage.extension(name)) = 'jpg'
);

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'spots'
  ) then
    alter publication supabase_realtime add table public.spots;
  end if;
end
$$;

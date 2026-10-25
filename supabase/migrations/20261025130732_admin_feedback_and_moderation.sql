-- Nett Hier admin access. Apply after supabase_update_v6.sql.
-- Existing sightings and reports are retained. Admin membership is granted only
-- through trusted SQL, never through sign-up metadata or the public website.
begin;

create table if not exists public.site_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.site_admins enable row level security;
revoke all on table public.site_admins from public, anon, authenticated;
grant select (user_id) on table public.site_admins to authenticated;

drop policy if exists "Users can check own admin membership" on public.site_admins;
create policy "Users can check own admin membership"
on public.site_admins for select to authenticated
using (user_id = (select auth.uid()));

-- Ordinary users retain their V6 ownership permissions. Admins can also manage
-- every other user's sightings and guest/legacy sightings without taking ownership.
alter table public.spots enable row level security;
grant update (lat, lng) on table public.spots to authenticated;

drop policy if exists "Admins can edit any spot" on public.spots;
create policy "Admins can edit any spot"
on public.spots for update to authenticated
using (exists (select 1 from public.site_admins where user_id = (select auth.uid())))
with check (
  exists (select 1 from public.site_admins where user_id = (select auth.uid()))
  and lat between -90 and 90
  and lng between -180 and 180
  and coalesce(char_length(place), 0) <= 120
  and coalesce(char_length(country), 0) <= 100
  and coalesce(char_length(note), 0) <= 500
  and coalesce(char_length(added_by), 0) <= 80
);

drop policy if exists "Admins can delete any spot" on public.spots;
create policy "Admins can delete any spot"
on public.spots for delete to authenticated
using (exists (select 1 from public.site_admins where user_id = (select auth.uid())));

-- Column grants apply to all authenticated users. This trigger prevents ordinary
-- owners from using the newly granted coordinate columns to move their own pins.
-- SECURITY INVOKER preserves the caller's permissions and RLS for the lookup.
create schema if not exists private;
create or replace function private.guard_spot_coordinates()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated')
    and (new.lat is distinct from old.lat or new.lng is distinct from old.lng)
    and not exists (select 1 from public.site_admins where user_id = (select auth.uid())) then
    raise exception 'Only admins can move sightings' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function private.guard_spot_coordinates() from public, anon, authenticated;

drop trigger if exists guard_spot_coordinates on public.spots;
create trigger guard_spot_coordinates
before update of lat, lng on public.spots
for each row execute function private.guard_spot_coordinates();

alter table public.spot_reports
  add column if not exists status text not null default 'open'
  check (status in ('open', 'resolved'));
alter table public.spot_reports enable row level security;
grant select on table public.spot_reports to authenticated;
grant update (status) on table public.spot_reports to authenticated;

drop policy if exists "Admins can read reports" on public.spot_reports;
create policy "Admins can read reports"
on public.spot_reports for select to authenticated
using (exists (select 1 from public.site_admins where user_id = (select auth.uid())));

drop policy if exists "Admins can resolve reports" on public.spot_reports;
create policy "Admins can resolve reports"
on public.spot_reports for update to authenticated
using (exists (select 1 from public.site_admins where user_id = (select auth.uid())))
with check (exists (select 1 from public.site_admins where user_id = (select auth.uid())));

-- Support the latitude bounds used by the fresh 1.5 m duplicate check.
create index if not exists spots_lat_lng_idx on public.spots (lat, lng);

commit;

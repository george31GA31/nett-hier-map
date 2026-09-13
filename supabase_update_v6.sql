-- Nett hier. Sticker Map — V6 ownership, reporting and security hardening
-- Additive migration: existing spots are preserved exactly as they are.

-- 1) Ownership. Existing rows remain NULL/legacy and therefore protected.
-- added_by existed in V4, but keep this migration safe for older installations too.
alter table public.spots
  add column if not exists added_by text;

alter table public.spots
  add column if not exists owner_id uuid references auth.users(id) on delete set null;

create index if not exists spots_owner_id_idx on public.spots (owner_id);

-- Only the agreed 198 country/territory codes are valid for new/edited country metadata.
-- NOT VALID deliberately preserves any historic row as-is while still enforcing this for future writes.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.spots'::regclass
      and conname = 'spots_country_code_allowed_198'
  ) then
    alter table public.spots
      add constraint spots_country_code_allowed_198
      check (
        country_code is null
        or country_code = any (array[
          'AF','AL','DZ','AD','AO','AG','AR','AM','AU','AT','AZ','BS','BH','BD','BB','BY','BE','BZ','BJ','BT','BO','BA','BW','BR','BN','BG','BF','BI','CV','KH','CM','CA','CF','TD','CL','CN','CO','KM','CG','CD','CR','CI','HR','CU','CY','CZ','DK','DJ','DM','DO','EC','EG','SV','GQ','ER','EE','SZ','ET','FJ','FI','FR','GA','GM','GE','DE','GH','GR','GD','GT','GN','GW','GY','HT','HN','HU','IS','IN','ID','IR','IQ','IE','IL','IT','JM','JP','JO','KZ','KE','KI','KP','KR','KW','KG','LA','LV','LB','LS','LR','LY','LI','LT','LU','MG','MW','MY','MV','ML','MT','MH','MR','MU','MX','FM','MD','MC','MN','ME','MA','MZ','MM','NA','NR','NP','NL','NZ','NI','NE','NG','MK','NO','OM','PK','PW','PA','PG','PY','PE','PH','PL','PT','QA','RO','RU','RW','KN','LC','VC','WS','SM','ST','SA','SN','RS','SC','SL','SG','SK','SI','SB','SO','ZA','SS','ES','LK','SD','SR','SE','CH','SY','TJ','TZ','TH','TL','TG','TO','TT','TN','TR','TM','TV','UG','UA','AE','GB','US','UY','UZ','VU','VE','VN','YE','ZM','ZW','VA','PS','TW','XK','EH'
        ]::text[])
      ) not valid;
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.spots'::regclass
      and conname = 'spots_sticker_type_nett_hier_only'
  ) then
    alter table public.spots
      add constraint spots_sticker_type_nett_hier_only
      check (sticker_type = 'nett_hier') not valid;
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.spots'::regclass
      and conname = 'spots_added_by_length'
  ) then
    alter table public.spots
      add constraint spots_added_by_length
      check (added_by is null or char_length(added_by) <= 80) not valid;
  end if;
end
$$;

-- Limit browser roles to the operations/columns they actually need.
revoke all on table public.spots from anon, authenticated;
grant select on table public.spots to anon, authenticated;
grant insert (
  lat, lng, place, country, country_code, sticker_type, note,
  spotted_on, image_url, added_by, owner_id
) on table public.spots to anon, authenticated;
grant update (place, country, country_code, note, spotted_on, added_by)
  on table public.spots to authenticated;
grant delete on table public.spots to authenticated;

-- Replace the old permissive write rules.
drop policy if exists "Anyone can add spots" on public.spots;
drop policy if exists "Anyone can edit spot metadata" on public.spots;
drop policy if exists "Guests can add unowned spots" on public.spots;
drop policy if exists "Users can add own spots" on public.spots;
drop policy if exists "Owners can edit own spots" on public.spots;
drop policy if exists "Owners can delete own spots" on public.spots;

create policy "Guests can add unowned spots"
on public.spots
for insert
to anon
with check (
  owner_id is null
  and lat between -90 and 90
  and lng between -180 and 180
  and coalesce(char_length(place), 0) <= 120
  and coalesce(char_length(country), 0) <= 100
  and (country_code is null or country_code = any (array[
    'AF','AL','DZ','AD','AO','AG','AR','AM','AU','AT','AZ','BS','BH','BD','BB','BY','BE','BZ','BJ','BT','BO','BA','BW','BR','BN','BG','BF','BI','CV','KH','CM','CA','CF','TD','CL','CN','CO','KM','CG','CD','CR','CI','HR','CU','CY','CZ','DK','DJ','DM','DO','EC','EG','SV','GQ','ER','EE','SZ','ET','FJ','FI','FR','GA','GM','GE','DE','GH','GR','GD','GT','GN','GW','GY','HT','HN','HU','IS','IN','ID','IR','IQ','IE','IL','IT','JM','JP','JO','KZ','KE','KI','KP','KR','KW','KG','LA','LV','LB','LS','LR','LY','LI','LT','LU','MG','MW','MY','MV','ML','MT','MH','MR','MU','MX','FM','MD','MC','MN','ME','MA','MZ','MM','NA','NR','NP','NL','NZ','NI','NE','NG','MK','NO','OM','PK','PW','PA','PG','PY','PE','PH','PL','PT','QA','RO','RU','RW','KN','LC','VC','WS','SM','ST','SA','SN','RS','SC','SL','SG','SK','SI','SB','SO','ZA','SS','ES','LK','SD','SR','SE','CH','SY','TJ','TZ','TH','TL','TG','TO','TT','TN','TR','TM','TV','UG','UA','AE','GB','US','UY','UZ','VU','VE','VN','YE','ZM','ZW','VA','PS','TW','XK','EH'
  ]::text[]))
  and sticker_type = 'nett_hier'
  and coalesce(char_length(note), 0) <= 500
  and coalesce(char_length(added_by), 0) between 1 and 80
  and image_url like 'https://ukkvukdzmdzpertbjjnp.supabase.co/storage/v1/object/public/sticker-photos/%'
  and char_length(image_url) <= 2000
);

create policy "Users can add own spots"
on public.spots
for insert
to authenticated
with check (
  (select auth.uid()) is not null
  and owner_id = (select auth.uid())
  and lat between -90 and 90
  and lng between -180 and 180
  and coalesce(char_length(place), 0) <= 120
  and coalesce(char_length(country), 0) <= 100
  and (country_code is null or country_code = any (array[
    'AF','AL','DZ','AD','AO','AG','AR','AM','AU','AT','AZ','BS','BH','BD','BB','BY','BE','BZ','BJ','BT','BO','BA','BW','BR','BN','BG','BF','BI','CV','KH','CM','CA','CF','TD','CL','CN','CO','KM','CG','CD','CR','CI','HR','CU','CY','CZ','DK','DJ','DM','DO','EC','EG','SV','GQ','ER','EE','SZ','ET','FJ','FI','FR','GA','GM','GE','DE','GH','GR','GD','GT','GN','GW','GY','HT','HN','HU','IS','IN','ID','IR','IQ','IE','IL','IT','JM','JP','JO','KZ','KE','KI','KP','KR','KW','KG','LA','LV','LB','LS','LR','LY','LI','LT','LU','MG','MW','MY','MV','ML','MT','MH','MR','MU','MX','FM','MD','MC','MN','ME','MA','MZ','MM','NA','NR','NP','NL','NZ','NI','NE','NG','MK','NO','OM','PK','PW','PA','PG','PY','PE','PH','PL','PT','QA','RO','RU','RW','KN','LC','VC','WS','SM','ST','SA','SN','RS','SC','SL','SG','SK','SI','SB','SO','ZA','SS','ES','LK','SD','SR','SE','CH','SY','TJ','TZ','TH','TL','TG','TO','TT','TN','TR','TM','TV','UG','UA','AE','GB','US','UY','UZ','VU','VE','VN','YE','ZM','ZW','VA','PS','TW','XK','EH'
  ]::text[]))
  and sticker_type = 'nett_hier'
  and coalesce(char_length(note), 0) <= 500
  and coalesce(char_length(added_by), 0) between 1 and 80
  and image_url like 'https://ukkvukdzmdzpertbjjnp.supabase.co/storage/v1/object/public/sticker-photos/%'
  and char_length(image_url) <= 2000
);

create policy "Owners can edit own spots"
on public.spots
for update
to authenticated
using ((select auth.uid()) is not null and owner_id = (select auth.uid()))
with check (
  owner_id = (select auth.uid())
  and coalesce(char_length(place), 0) <= 120
  and coalesce(char_length(country), 0) <= 100
  and (country_code is null or country_code = any (array[
    'AF','AL','DZ','AD','AO','AG','AR','AM','AU','AT','AZ','BS','BH','BD','BB','BY','BE','BZ','BJ','BT','BO','BA','BW','BR','BN','BG','BF','BI','CV','KH','CM','CA','CF','TD','CL','CN','CO','KM','CG','CD','CR','CI','HR','CU','CY','CZ','DK','DJ','DM','DO','EC','EG','SV','GQ','ER','EE','SZ','ET','FJ','FI','FR','GA','GM','GE','DE','GH','GR','GD','GT','GN','GW','GY','HT','HN','HU','IS','IN','ID','IR','IQ','IE','IL','IT','JM','JP','JO','KZ','KE','KI','KP','KR','KW','KG','LA','LV','LB','LS','LR','LY','LI','LT','LU','MG','MW','MY','MV','ML','MT','MH','MR','MU','MX','FM','MD','MC','MN','ME','MA','MZ','MM','NA','NR','NP','NL','NZ','NI','NE','NG','MK','NO','OM','PK','PW','PA','PG','PY','PE','PH','PL','PT','QA','RO','RU','RW','KN','LC','VC','WS','SM','ST','SA','SN','RS','SC','SL','SG','SK','SI','SB','SO','ZA','SS','ES','LK','SD','SR','SE','CH','SY','TJ','TZ','TH','TL','TG','TO','TT','TN','TR','TM','TV','UG','UA','AE','GB','US','UY','UZ','VU','VE','VN','YE','ZM','ZW','VA','PS','TW','XK','EH'
  ]::text[]))
  and coalesce(char_length(note), 0) <= 500
  and coalesce(char_length(added_by), 0) between 1 and 80
);

create policy "Owners can delete own spots"
on public.spots
for delete
to authenticated
using ((select auth.uid()) is not null and owner_id = (select auth.uid()));

-- 2) Reports. Reports are write-only to ordinary visitors; only privileged/admin access can read them.
create table if not exists public.spot_reports (
  id uuid primary key default gen_random_uuid(),
  spot_id uuid not null references public.spots(id) on delete cascade,
  reason text not null check (reason in (
    'Not there anymore',
    'Wrong location',
    'Wrong variation of the Nett Hier / Not Bad sticker',
    'Inappropriate',
    'Too damaged',
    'Other'
  )),
  comment text check (comment is null or (reason = 'Other' and char_length(comment) <= 50)),
  reported_at timestamptz not null default now(),
  reporter_user_id uuid references auth.users(id) on delete set null,
  reporter_token uuid,
  -- Both NULL is allowed only so a report can survive account deletion; RLS prevents it on insert.
  check (not (reporter_user_id is not null and reporter_token is not null))
);

create index if not exists spot_reports_spot_id_idx on public.spot_reports (spot_id);
create index if not exists spot_reports_reported_at_idx on public.spot_reports (reported_at desc);
create unique index if not exists spot_reports_one_per_user_idx
  on public.spot_reports (spot_id, reporter_user_id)
  where reporter_user_id is not null;
create unique index if not exists spot_reports_one_per_guest_token_idx
  on public.spot_reports (spot_id, reporter_token)
  where reporter_token is not null;

alter table public.spot_reports enable row level security;
revoke all on table public.spot_reports from anon, authenticated;
grant insert (spot_id, reason, comment, reporter_user_id, reporter_token)
  on table public.spot_reports to anon, authenticated;

drop policy if exists "Guests can report spots" on public.spot_reports;
drop policy if exists "Users can report other spots" on public.spot_reports;

create policy "Guests can report spots"
on public.spot_reports
for insert
to anon
with check (
  reporter_user_id is null
  and reporter_token is not null
  and exists (select 1 from public.spots s where s.id = spot_id)
);

create policy "Users can report other spots"
on public.spot_reports
for insert
to authenticated
with check (
  reporter_user_id = (select auth.uid())
  and reporter_token is null
  and exists (
    select 1 from public.spots s
    where s.id = spot_id
      and (s.owner_id is null or s.owner_id <> (select auth.uid()))
  )
);

-- 3) Storage hardening. Keep public JPEG uploads for guest plotting, but constrain names.
update storage.buckets
set file_size_limit = 6291456,
    allowed_mime_types = array['image/jpeg']
where id = 'sticker-photos';

drop policy if exists "Anyone can upload sticker photos" on storage.objects;
create policy "Anyone can upload sticker photos"
on storage.objects
for insert
to anon, authenticated
with check (
  bucket_id = 'sticker-photos'
  and lower(storage.extension(name)) = 'jpg'
  and name ~ '^[0-9]{13}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jpg$'
);

-- Apply after supabase_update_v6.sql. No existing sightings, identities or objects
-- are rewritten or deleted. Review policies with ops/audit.sql before applying.
begin;
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

create table private.launch_controls (
  singleton boolean primary key default true check (singleton),
  submissions_paused boolean not null default true,
  daily_sightings integer not null default 250 check (daily_sightings > 0),
  daily_upload_bytes bigint not null default 1073741824 check (daily_upload_bytes > 0),
  storage_budget_bytes bigint not null default 4294967296 check (storage_budget_bytes > 0)
);
insert into private.launch_controls(singleton) values(true);
create table private.moderators (user_id uuid primary key references auth.users(id) on delete cascade);
create table private.blocked_accounts (user_id uuid primary key, blocked_at timestamptz not null default now());
create table private.quotas (
  scope text not null, bucket timestamptz not null, used bigint not null check(used >= 0),
  primary key(scope,bucket)
);
create table private.managed_photos (
  path text primary key, request_id uuid not null unique,
  owner_id uuid, created_at timestamptz not null default now(),
  committed boolean not null default false
);
create table private.photo_cleanup (
  path text primary key, queued_at timestamptz not null default now(),
  attempts integer not null default 0, last_error text
);
create table private.support_requests (
 id uuid primary key default gen_random_uuid(), spot_id uuid,
 reply_to text check(length(reply_to)<=254), message text not null check(length(message) between 1 and 2000),
 created_at timestamptz not null default now(), resolved_at timestamptz
);
alter table private.support_requests enable row level security;
create table private.geocode_cache (
  cache_key text primary key, result jsonb not null, expires_at timestamptz not null
);
create table private.geocode_gate (
  singleton boolean primary key default true check(singleton),
  available_at timestamptz not null default now()
);
insert into private.geocode_gate(singleton) values(true);
create table private.moderation_log (
  id bigint generated always as identity primary key,
  moderator_id uuid not null, action text not null, target_id uuid,
  acted_at timestamptz not null default now()
);
-- RLS is defense in depth. Only restricted service RPCs can access these tables.
alter table private.launch_controls enable row level security;
alter table private.moderators enable row level security;
alter table private.blocked_accounts enable row level security;
alter table private.quotas enable row level security;
alter table private.managed_photos enable row level security;
alter table private.photo_cleanup enable row level security;
alter table private.geocode_cache enable row level security;
alter table private.geocode_gate enable row level security;
alter table private.moderation_log enable row level security;

alter table public.spots add column if not exists photo_path text;
alter table public.spot_reports add column if not exists resolved_at timestamptz;
alter table public.spot_reports add column if not exists resolved_by uuid;
create unique index spots_photo_path_unique on public.spots(photo_path) where photo_path is not null;
create index spots_viewport_idx on public.spots(lat,lng,id);
create index spots_id_page_idx on public.spots(id);
create index reports_open_idx on public.spot_reports(reported_at,id) where resolved_at is null;

-- Remove inherited PUBLIC and any historical column-level write grants too.
revoke all on public.spots,public.spot_reports from public;
do $$ declare cols text; t text; begin
 foreach t in array array['spots','spot_reports'] loop
   select string_agg(quote_ident(attname),',') into cols from pg_attribute
   where attrelid=('public.'||t)::regclass and attnum>0 and not attisdropped;
   execute format('revoke insert(%s),update(%s),references(%s) on public.%I from public,anon,authenticated',cols,cols,cols,t);
   if t='spot_reports' then
     execute format('revoke select(%s) on public.%I from public,anon,authenticated',cols,t);
   end if;
 end loop;
end $$;
alter table storage.objects enable row level security;

-- Cut off every direct insert route, including old column grants. No client may
-- upload or delete storage objects. Only the backend's service credential can.
revoke insert on public.spots, public.spot_reports from anon, authenticated;
revoke insert(lat,lng,place,country,country_code,sticker_type,note,spotted_on,image_url,added_by,owner_id)
  on public.spots from anon, authenticated;
revoke insert(spot_id,reason,comment,reporter_user_id,reporter_token)
  on public.spot_reports from anon, authenticated;
revoke all on public.spot_reports from anon, authenticated;
-- Also remove V4's column-level grants; REVOKE ALL at table level is not enough.
revoke update(place,country,country_code,sticker_type,note,spotted_on,added_by)
  on public.spots from anon, authenticated;
grant update(place,country,country_code,note,spotted_on,added_by) on public.spots to authenticated;
-- All public writes are backend-only; existing RLS remains a second boundary.
revoke update,delete on public.spots from anon,authenticated;
revoke update(place,country,country_code,note,spotted_on,added_by) on public.spots from authenticated;
alter table public.spots enable row level security;
alter table public.spot_reports enable row level security;
-- Remove known old storage rule. Abort if unknown bucket write rules remain;
-- the audit script lists these so they can be reviewed, never silently dropped.
drop policy if exists "Anyone can upload sticker photos" on storage.objects;
do $$ begin
 if exists(select 1 from pg_policies where schemaname='storage' and tablename='objects'
   and cmd in ('INSERT','UPDATE','DELETE','ALL') and roles && array['anon','authenticated','public']::name[]) then
   raise exception 'Review remaining sticker-photos write policies before applying launch migration';
 end if;
end $$;

create function private.take_quota(k text, b timestamptz, amount bigint, maximum bigint)
returns void language plpgsql set search_path='' as $$
begin
 insert into private.quotas(scope,bucket,used) values(k,b,amount)
 on conflict(scope,bucket) do update set used=private.quotas.used+excluded.used
 where private.quotas.used+excluded.used<=maximum;
 if not found or amount>maximum then raise exception 'QUOTA_EXCEEDED' using errcode='P0001'; end if;
end $$;

create function public.nh_reserve(action text, actor text, account_id uuid default null, upload_bytes bigint default 0)
returns void language plpgsql security definer set search_path='' as $$
declare c private.launch_controls; h timestamptz:=date_trunc('hour',now()); d timestamptz:=date_trunc('day',now());
begin
 select * into c from private.launch_controls where singleton;
 if c.submissions_paused then raise exception 'SUBMISSIONS_PAUSED'; end if;
 if exists(select 1 from private.blocked_accounts where user_id=account_id) then raise exception 'ACCOUNT_BLOCKED'; end if;
 if action not in ('sighting','report','geocode') or length(actor)<>64 then raise exception 'INVALID_REQUEST'; end if;
 perform private.take_quota('ip:'||actor||':'||action,h,1,case action when 'sighting' then 5 when 'report' then 10 else 30 end);
 if account_id is not null then
   perform private.take_quota('user:'||account_id||':'||action,d,1,case action when 'sighting' then 20 when 'report' then 30 else 200 end);
 end if;
 perform private.take_quota('global:'||action,d,1,case action when 'sighting' then c.daily_sightings when 'report' then 500 else 10000 end);
 if action='sighting' then
   if upload_bytes<1 or upload_bytes>6291456 then raise exception 'INVALID_PHOTO_SIZE'; end if;
   perform private.take_quota('upload-bytes',d,upload_bytes,c.daily_upload_bytes);
   if (select coalesce(sum((metadata->>'size')::bigint),0) from storage.objects where bucket_id='sticker-photos')+upload_bytes>c.storage_budget_bytes then
     raise exception 'STORAGE_BUDGET_REACHED';
   end if;
 end if;
end $$;

create function public.nh_photo_reserve(request_id uuid, account_id uuid)
returns text language plpgsql security definer set search_path='' as $$
declare p text:='managed/'||request_id||'.jpg';
begin
 insert into private.managed_photos(path,request_id,owner_id) values(p,request_id,account_id);
 return p;
end $$;

create function public.nh_create_spot(payload jsonb, path text, account_id uuid)
returns public.spots language plpgsql security definer set search_path='' as $$
declare s public.spots;
begin
 if account_id is not null then perform pg_advisory_xact_lock(hashtextextended(account_id::text,0)); end if;
 if exists(select 1 from private.blocked_accounts where user_id=account_id) then raise exception 'ACCOUNT_BLOCKED'; end if;
 -- Lock the reservation to prevent cleanup racing a commit.
 perform 1 from private.managed_photos p where p.path=nh_create_spot.path
   and p.owner_id is not distinct from account_id and not p.committed
   and p.created_at>now()-interval '1 hour' for update;
 if not found then raise exception 'INVALID_PHOTO_RESERVATION'; end if;
 if not exists(select 1 from storage.objects o where o.bucket_id='sticker-photos' and o.name=path) then
   raise exception 'PHOTO_MISSING';
 end if;
 insert into public.spots(lat,lng,place,country,country_code,sticker_type,note,spotted_on,added_by,owner_id,image_url,photo_path)
 values((payload->>'lat')::float8,(payload->>'lng')::float8,left(payload->>'place',120),
 left(payload->>'country',100),payload->>'country_code','nett_hier',left(payload->>'note',500),
 (payload->>'spotted_on')::date,left(payload->>'added_by',80),account_id,
 'https://ukkvukdzmdzpertbjjnp.supabase.co/storage/v1/object/public/sticker-photos/'||path,path) returning * into s;
 update private.managed_photos p set committed=true where p.path=nh_create_spot.path;
 return s;
end $$;

create function private.queue_deleted_photo() returns trigger language plpgsql security definer set search_path='' as $$
declare p text; prefix constant text:='https://ukkvukdzmdzpertbjjnp.supabase.co/storage/v1/object/public/sticker-photos/';
begin
 p:=old.photo_path;
 if p is null and left(old.image_url,length(prefix))=prefix then p:=substr(old.image_url,length(prefix)+1); end if;
 -- Only a known bucket-relative JPEG path, never an arbitrary URL/bucket.
 if p ~ '^(managed/)?[a-zA-Z0-9_-]+\.jpg$' then
   insert into private.photo_cleanup(path) values(p) on conflict do nothing;
 end if;
 return old;
end $$;
create trigger nh_spot_photo_cleanup after delete on public.spots for each row execute function private.queue_deleted_photo();

create function public.nh_cleanup_candidates() returns table(path text)
language plpgsql security definer set search_path='' as $$
begin
 -- Only managed uploads are auto-cleaned; historic unreferenced photos need review.
 insert into private.photo_cleanup(path)
 select p.path from private.managed_photos p where not p.committed and p.created_at<now()-interval '1 hour'
 for update skip locked on conflict do nothing;
 return query select q.path from private.photo_cleanup q where not exists(
   select 1 from public.spots s where s.photo_path=q.path or s.image_url=
   'https://ukkvukdzmdzpertbjjnp.supabase.co/storage/v1/object/public/sticker-photos/'||q.path
 ) order by q.queued_at limit 100;
end $$;
create function public.nh_cleanup_result(photo text, failure text default null) returns void
language plpgsql security definer set search_path='' as $$
begin
 if failure is null then
   delete from private.photo_cleanup where path=photo;
   delete from private.managed_photos where path=photo;
 else update private.photo_cleanup set attempts=attempts+1,last_error=left(failure,300) where path=photo; end if;
 delete from private.quotas where bucket<now()-interval '2 days';
 delete from private.geocode_cache where expires_at<now();
end $$;

create function public.nh_is_moderator(account_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from private.moderators where user_id=account_id)
 and not exists(select 1 from private.blocked_accounts where user_id=account_id);
$$;
create function public.nh_moderation(account_id uuid, action text, target uuid default null, paused boolean default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 if not public.nh_is_moderator(account_id) then raise exception 'FORBIDDEN'; end if;
 if action='list' then
   select jsonb_build_object('reports',coalesce((select jsonb_agg(r) from (
     select r.id,r.spot_id,r.reason,r.comment,r.reported_at,s.place,s.lat,s.lng,s.image_url
     from public.spot_reports r join public.spots s on s.id=r.spot_id
     where r.resolved_at is null order by r.reported_at limit 100)r),'[]'::jsonb),
     'openReports',(select count(*) from public.spot_reports where resolved_at is null),
     'paused',(select submissions_paused from private.launch_controls where singleton),
     'storageBytes',(select coalesce(sum((metadata->>'size')::bigint),0) from storage.objects where bucket_id='sticker-photos'),
     'storageBudget',(select storage_budget_bytes from private.launch_controls where singleton),
     'cleanupPending',(select count(*) from private.photo_cleanup),
     'requests',coalesce((select jsonb_agg(x) from(select id,spot_id,reply_to,message,created_at from private.support_requests where resolved_at is null order by created_at limit 100)x),'[]'::jsonb)) into result;
   return result;
 elsif action='remove' then delete from public.spots where id=target;
 elsif action='resolve' then
   update public.spot_reports set resolved_at=now(),resolved_by=account_id where id=target;
   update private.support_requests set resolved_at=now() where id=target;
 elsif action='pause' and paused is not null then update private.launch_controls set submissions_paused=paused where singleton;
 else raise exception 'INVALID_ACTION'; end if;
 insert into private.moderation_log(moderator_id,action,target_id) values(account_id,action,target);
 return jsonb_build_object('ok',true);
end $$;

create function public.nh_delete_account_data(account_id uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(account_id::text,0));
 insert into private.blocked_accounts(user_id) values(account_id) on conflict do nothing;
 delete from public.spots where owner_id=account_id;
 delete from public.spot_reports where reporter_user_id=account_id;
 -- This operation is followed by Auth global sign-out and admin.deleteUser.
 -- A surviving JWT cannot write through the backend after this tombstone.
end $$;
create function public.nh_account_allowed(account_id uuid) returns boolean language sql stable security definer set search_path='' as $$
 select not exists(select 1 from private.blocked_accounts where user_id=account_id);
$$;

create function public.nh_support(spot_id uuid, reply_to text, message text) returns void
language sql security definer set search_path='' as $$
 insert into private.support_requests(spot_id,reply_to,message) values(spot_id,reply_to,message);
$$;

-- Exact incremental statistics: avoid scanning every sighting for every viewer.
-- The write lock also makes the initial snapshot and trigger installation atomic.
lock table public.spots in share row exclusive mode;
create table private.sighting_total(singleton boolean primary key check(singleton), total bigint not null);
insert into private.sighting_total select true,count(*) from public.spots;
create table private.country_counts(code text primary key,name text not null,count bigint not null check(count>=0));
insert into private.country_counts select country_code,coalesce(min(country),country_code),count(*)
 from public.spots where country_code is not null group by country_code;
alter table private.sighting_total enable row level security;
alter table private.country_counts enable row level security;
create function private.update_sighting_counts() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='UPDATE' and old.country_code is not distinct from new.country_code and old.country is not distinct from new.country then return new; end if;
 if tg_op='DELETE' then update private.sighting_total set total=total-1 where singleton;
 elsif tg_op='INSERT' then update private.sighting_total set total=total+1 where singleton; end if;
 if tg_op in('DELETE','UPDATE') and old.country_code is not null then
   update private.country_counts set count=count-1 where code=old.country_code;
   delete from private.country_counts where code=old.country_code and count=0;
 end if;
 if tg_op in('INSERT','UPDATE') and new.country_code is not null then
   insert into private.country_counts values(new.country_code,coalesce(new.country,new.country_code),1)
   on conflict(code) do update set count=private.country_counts.count+1,name=least(private.country_counts.name,excluded.name);
 end if;
 return coalesce(new,old);
end $$;
create trigger nh_sighting_counts after insert or update or delete on public.spots for each row execute function private.update_sighting_counts();

-- Public reads: scalar JSON avoids PostgREST max_rows truncating aggregates.
-- Intentional aggregate-only SECURITY DEFINER: returns counts, never private rows.
create function public.nh_stats() returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('total',(select total from private.sighting_total where singleton),
 'countries',coalesce((select jsonb_agg(c order by c.count desc,c.name) from(
 select code,name,count from private.country_counts where count>0)c),'[]'::jsonb));
$$;
create function public.nh_map_page(south float8, north float8, west float8, east float8, after_id uuid default null)
returns jsonb language sql stable security invoker set search_path='' as $$
 with page as (
  select id,lat,lng,place,country,country_code,note,spotted_on,image_url,added_by,owner_id,created_at
  from public.spots where lat between south and north
  and (case when west<=east then lng between west and east else lng>=west or lng<=east end)
  and (after_id is null or id>after_id) order by id limit 500
 ) select jsonb_build_object('spots',coalesce(jsonb_agg(p order by p.id),'[]'::jsonb),
 'next',case when count(*)=500 then (array_agg(p.id order by p.id desc))[1] else null end) from page p;
$$;

create function public.nh_clusters(south float8, north float8, west float8, east float8, cell float8)
returns jsonb language sql stable security invoker set search_path='' as $$
 select coalesce(jsonb_agg(c),'[]'::jsonb) from (
 select avg(lat) as lat,avg(lng) as lng,count(*) as count from public.spots
 where lat between south and north and (case when west<=east then lng between west and east else lng>=west or lng<=east end)
 group by floor(lat/greatest(cell,0.01)),floor(lng/greatest(cell,0.01)))c;
$$;

-- One globally shared lease. Keep held until AFTER upstream response + 1100ms:
-- even an Edge isolate paused by scheduling cannot create an upstream burst.
create function public.nh_geocode_claim(cache_key text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare cached jsonb; gate private.geocode_gate;
begin
 select result into cached from private.geocode_cache c where c.cache_key=nh_geocode_claim.cache_key and expires_at>now();
 if found then return jsonb_build_object('cached',cached); end if;
 select * into gate from private.geocode_gate where singleton for update;
 if gate.available_at>clock_timestamp() then return jsonb_build_object('busy',true); end if;
 -- A crashed request stays closed until maintenance/admin resets the lease.
 update private.geocode_gate set available_at='infinity' where singleton;
 return jsonb_build_object('claimed',true);
end $$;
create function public.nh_geocode_finish(cache_key text, result jsonb) returns void
language plpgsql security definer set search_path='' as $$
begin
 if result is not null then insert into private.geocode_cache values(cache_key,result,now()+interval '30 days')
 on conflict on constraint geocode_cache_pkey do update set result=excluded.result,expires_at=excluded.expires_at; end if;
 update private.geocode_gate set available_at=clock_timestamp()+interval '1100 milliseconds' where singleton;
end $$;

create function public.nh_operational_status() returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
 'storageBytes',(select coalesce(sum((metadata->>'size')::bigint),0) from storage.objects where bucket_id='sticker-photos'),
 'storageBudget',(select storage_budget_bytes from private.launch_controls where singleton),
 'openReports',(select count(*) from public.spot_reports where resolved_at is null),
 'openRequests',(select count(*) from private.support_requests where resolved_at is null),
 'oldestCleanupHours',(select coalesce(extract(epoch from now()-min(queued_at))/3600,0) from private.photo_cleanup));
$$;

-- Every privileged public RPC is service-only, including default PUBLIC execute.
do $$ declare f record; begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where (n.nspname='public' and p.proname like 'nh_%') or n.nspname='private'
 loop
   execute format('revoke all on function %s from public,anon,authenticated',f.signature);
   execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
grant execute on function public.nh_stats(),public.nh_clusters(float8,float8,float8,float8,float8),public.nh_map_page(float8,float8,float8,float8,uuid) to anon,authenticated;
grant select,insert,update,delete on public.spots,public.spot_reports to service_role;
commit;

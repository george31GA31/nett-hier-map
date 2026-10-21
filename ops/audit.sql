-- Read-only. Run before AND after the launch migration on the actual project.
select current_database(), version();
select c.oid::regclass as relation,c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
where (n.nspname='public' and c.relname in ('spots','spot_reports')) or (n.nspname='storage' and c.relname='objects');
select schemaname,tablename,policyname,roles,cmd,qual,with_check from pg_policies
where (schemaname='public' and tablename in('spots','spot_reports')) or (schemaname='storage' and tablename='objects') order by 1,2,3;
select grantee,table_schema,table_name,privilege_type from information_schema.role_table_grants
where grantee in('anon','authenticated','PUBLIC') and table_schema in('public','storage') and table_name in('spots','spot_reports','objects');
select grantee,table_name,column_name,privilege_type from information_schema.column_privileges
where grantee in('anon','authenticated','PUBLIC') and table_schema='public' and table_name in('spots','spot_reports');
select n.nspname,p.proname,p.prosecdef,p.proconfig,p.proacl from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where (n.nspname='public' and p.proname like 'nh_%') or n.nspname='private';
select tgname,pg_get_triggerdef(oid) from pg_trigger where tgrelid='public.spots'::regclass and not tgisinternal;
select count(*) as sightings,count(owner_id) as owned_sightings from public.spots;
select bucket_id,count(*) as objects,sum((metadata->>'size')::bigint) as bytes from storage.objects group by bucket_id;
-- These MUST be false after migration. Column-level grants matter too.
select role_name,has_table_privilege(role_name,'public.spots','INSERT') as table_insert,
 has_any_column_privilege(role_name,'public.spots','INSERT') as any_column_insert,
 has_any_column_privilege(role_name,'public.spots','UPDATE') as any_column_update,
 has_table_privilege(role_name,'public.spots','DELETE') as can_delete,
 has_table_privilege(role_name,'public.spot_reports','SELECT') as read_reports
from unnest(array['anon','authenticated']) role_name;

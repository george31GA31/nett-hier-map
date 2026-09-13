-- Follow-up V6 performance index identified by Supabase's database advisor.
create index if not exists spot_reports_reporter_user_id_idx
  on public.spot_reports (reporter_user_id)
  where reporter_user_id is not null;

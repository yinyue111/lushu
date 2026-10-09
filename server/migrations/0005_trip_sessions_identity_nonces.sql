alter table trusted_routebook.event_rows drop constraint if exists event_rows_stream_check;
alter table trusted_routebook.event_rows add constraint event_rows_stream_check check (
  stream in ('ai-logs', 'identity-nonces', 'checkins', 'trip-sessions', 'ops-audits',
    'clicks', 'exposures', 'routebooks', 'routebook-audits', 'profiles',
    'profile-lifecycle', 'poi-corrections', 'poi-knowledge', 'pois', 'reviews',
    'imports', 'favorites', 'checkin-photos')
);

-- Re-run parity before switching writers so newer filesystem streams are not lost.
update trusted_routebook.storage_state set
  schema_version = 5,
  phase = case when cutover_ready then 'backfilled' else phase end,
  cutover_ready = false,
  parity_report = null,
  parity_checked_at = null,
  updated_at = clock_timestamp()
where singleton_id = 1;

alter table trusted_routebook.event_rows
  drop constraint if exists event_rows_stream_check;

alter table trusted_routebook.event_rows
  add constraint event_rows_stream_check check (
    stream in (
      'ai-logs',
      'checkins',
      'ops-audits',
      'clicks',
      'exposures',
      'routebooks',
      'routebook-audits',
      'profiles',
      'profile-lifecycle',
      'poi-corrections',
      'poi-knowledge',
      'pois',
      'reviews',
      'imports',
      'favorites',
      'checkin-photos'
    )
  );

-- The new append-only stream participates in the filesystem snapshot and
-- parity manifest. A previously-ready database must pass parity again before
-- runtime writes resume, otherwise an existing ops-audits.jsonl could be lost.
update trusted_routebook.storage_state
set
  schema_version = 4,
  phase = case when cutover_ready then 'backfilled' else phase end,
  cutover_ready = false,
  parity_report = case when cutover_ready then null else parity_report end,
  parity_checked_at = case when cutover_ready then null else parity_checked_at end,
  updated_at = clock_timestamp()
where singleton_id = 1;

comment on table trusted_routebook.event_rows is
  'Append-ordered authoritative rows for the 16 historical JSONL streams. No runtime dual-write or JSONL fallback is permitted.';

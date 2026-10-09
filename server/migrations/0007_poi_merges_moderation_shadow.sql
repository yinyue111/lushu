-- Three new append-only streams:
--   poi-merges        human-confirmed POI duplicate decisions (merge / reject / unmerge)
--   moderation-queue  content-safety pre-filter hits awaiting ops review
--   shadow-judgments  shadow-mode model judgments (never affect behaviour)
-- They start empty, so an existing parity report stays valid: no parity reset.
alter table trusted_routebook.event_rows drop constraint if exists event_rows_stream_check;
alter table trusted_routebook.event_rows add constraint event_rows_stream_check check (
  stream in ('ai-logs', 'identity-nonces', 'checkins', 'trip-sessions', 'ops-audits',
    'clicks', 'exposures', 'routebooks', 'routebook-audits', 'profiles',
    'profile-lifecycle', 'poi-corrections', 'poi-knowledge', 'pois', 'reviews',
    'imports', 'favorites', 'checkin-photos',
    'poi-merges', 'moderation-queue', 'shadow-judgments')
);

update trusted_routebook.storage_state
set
  schema_version = 7,
  updated_at = clock_timestamp()
where singleton_id = 1
  and schema_version < 7;

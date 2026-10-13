-- Two new append-only streams for the beta:
--   funnel-events  activation funnel (home_view, create_start, register_complete, share_open); no PII, hashed key only
--   client-errors  front-end error reports (message, short stack, path without query)
-- They start empty, so an existing parity report stays valid: no parity reset.
alter table trusted_routebook.event_rows drop constraint if exists event_rows_stream_check;
alter table trusted_routebook.event_rows add constraint event_rows_stream_check check (
  stream in ('ai-logs', 'identity-nonces', 'checkins', 'trip-sessions', 'ops-audits',
    'clicks', 'exposures', 'routebooks', 'routebook-audits', 'profiles',
    'profile-lifecycle', 'poi-corrections', 'poi-knowledge', 'pois', 'reviews',
    'imports', 'favorites', 'checkin-photos',
    'poi-merges', 'moderation-queue', 'shadow-judgments',
    'funnel-events', 'client-errors')
);

update trusted_routebook.storage_state
set
  schema_version = 11,
  updated_at = clock_timestamp()
where singleton_id = 1
  and schema_version < 11;

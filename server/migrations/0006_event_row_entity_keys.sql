-- Keyed lookups for append-only streams (see server/storage/entityKeys.mjs).
--
-- entity_key is computed by the application (the key functions sanitize ids in
-- JavaScript, so SQL cannot reproduce them exactly):
--   NULL  = not computed yet; readers evaluate such rows in JS, so lookups stay
--           correct before and during the online backfill.
--   ''    = computed, no key.
-- This migration is additive: no stream changes, no parity reset.

alter table trusted_routebook.event_rows
  add column if not exists entity_key text;

-- "Latest row for entity X": (stream, entity_key) equality + ordinal desc, LIMIT 1.
create index if not exists event_rows_stream_entity_key_idx
  on trusted_routebook.event_rows (stream, entity_key, ordinal desc)
  where entity_key is not null and entity_key <> '';

-- Rows still waiting for the backfill. Empty in steady state, so the
-- correctness fallback costs one empty index probe per lookup.
create index if not exists event_rows_entity_key_pending_idx
  on trusted_routebook.event_rows (stream, ordinal desc)
  where entity_key is null;

-- Registration / recovery: latest profile row carrying a credential hash.
create index if not exists event_rows_profile_registration_hash_idx
  on trusted_routebook.event_rows ((payload->>'registrationCredentialHash'), ordinal desc)
  where stream = 'profiles';

comment on column trusted_routebook.event_rows.entity_key is
  'Application-computed entity key (server/storage/entityKeys.mjs). NULL = not yet computed; empty = no key.';

update trusted_routebook.storage_state
set
  schema_version = 6,
  updated_at = clock_timestamp()
where singleton_id = 1
  and schema_version < 6;

alter table trusted_routebook.storage_state
  add column if not exists profile_secret_fingerprint text;

alter table trusted_routebook.storage_state
  drop constraint if exists storage_state_profile_secret_fingerprint_check;

alter table trusted_routebook.storage_state
  add constraint storage_state_profile_secret_fingerprint_check check (
    profile_secret_fingerprint is null or
    profile_secret_fingerprint ~ '^[0-9a-f]{64}$'
  );

-- A database that was marked ready before the secret fingerprint existed must
-- pass parity again with the intended PROFILE_ID_SECRET. Keeping it online
-- would silently invalidate profile tokens, recovery proofs and photo URLs.
update trusted_routebook.storage_state
set
  schema_version = 3,
  phase = case when cutover_ready then 'backfilled' else phase end,
  cutover_ready = false,
  parity_report = case when cutover_ready then null else parity_report end,
  parity_checked_at = case when cutover_ready then null else parity_checked_at end,
  updated_at = clock_timestamp()
where singleton_id = 1;

alter table trusted_routebook.storage_state
  drop constraint if exists storage_state_ready_check;

alter table trusted_routebook.storage_state
  add constraint storage_state_ready_check check (
    not cutover_ready or (
      phase = 'ready' and
      source_manifest_sha256 is not null and
      source_manifest is not null and
      parity_report is not null and
      profile_secret_fingerprint is not null and
      backfilled_at is not null and
      parity_checked_at is not null
    )
  );

comment on column trusted_routebook.storage_state.profile_secret_fingerprint is
  'Irreversible deployment fingerprint used to fail closed when PROFILE_ID_SECRET differs from backfill/parity.';

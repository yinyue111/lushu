-- Rollback for 0011 (manual, run only when switching code back to a build that expects schema 10).
-- Keeps the funnel-events / client-errors rows and the wider stream check (older code never writes
-- those streams, so the extra allowed names are harmless). Only the version marker goes back,
-- because older servers refuse to start unless schema_version matches exactly.
update trusted_routebook.storage_state
set
  schema_version = 10,
  updated_at = clock_timestamp()
where singleton_id = 1
  and schema_version = 11;

-- Forget the ledger entry so a later forward migrate re-applies it (the migration is idempotent).
delete from trusted_routebook.schema_migrations where migration_name = '0011_funnel_client_errors.sql';

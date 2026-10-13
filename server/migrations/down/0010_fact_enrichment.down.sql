-- Rollback for 0010 (manual, only when going back to a build that expects schema 9).
-- Production has been on schema 10 since before the beta, so this is NOT part of the beta rollback.
-- Default: keep the enrich_* tables (unused by older code) and only move the version marker.
update trusted_routebook.storage_state
set
  schema_version = 9,
  updated_at = clock_timestamp()
where singleton_id = 1
  and schema_version = 10;
-- Only if the data must really go (irreversible; take a backup first):
-- drop table if exists trusted_routebook.enrich_reports, trusted_routebook.enrich_spend,
--   trusted_routebook.enrich_cache, trusted_routebook.enrich_results, trusted_routebook.enrich_jobs;

-- Forget the ledger entry so a later forward migrate re-applies it (the migration is idempotent).
delete from trusted_routebook.schema_migrations where migration_name = '0010_fact_enrichment.sql';

-- Rollback for 0012. Code from this release on runs on schema 11 and 12, so rolling back between such
-- images needs no SQL. Only needed to go back to a pre-0012 image (those require exactly 11). Default keeps data and only moves the version marker back.
-- The admin tables and the enrich_reports.status/resolved_* columns are kept (older code ignores them),
-- so rolling forward again loses nothing. To drop them for good, run the commented statements below.
update trusted_routebook.storage_state
set
  schema_version = 11,
  updated_at = clock_timestamp()
where singleton_id = 1
  and schema_version = 12;

delete from trusted_routebook.schema_migrations where migration_name = '0012_admin_config.sql';

-- drop table if exists trusted_routebook.admin_config_versions, trusted_routebook.admin_users,
--   trusted_routebook.admin_sessions, trusted_routebook.admin_audit, trusted_routebook.admin_invite_codes,
--   trusted_routebook.admin_corrections, trusted_routebook.admin_quota_resets,
--   trusted_routebook.admin_verified_facts;
-- drop function if exists trusted_routebook.admin_audit_append_only() cascade;
-- alter table trusted_routebook.enrich_reports drop column if exists status, drop column if exists resolved_by, drop column if exists resolved_at, drop column if exists source;

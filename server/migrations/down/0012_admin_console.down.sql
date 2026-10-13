-- Rollback for 0012 (manual, run only when switching code back to a build that expects schema 11).
-- The admin tables and the enrich_reports.status/resolved_* columns are kept (older code ignores them),
-- so rolling forward again loses nothing. To drop them for good, run the commented statements below.
update trusted_routebook.storage_state
set
  schema_version = 11,
  updated_at = clock_timestamp()
where singleton_id = 1
  and schema_version = 12;

delete from trusted_routebook.schema_migrations where migration_name = '0012_admin_console.sql';

-- drop table if exists trusted_routebook.admin_config_versions, trusted_routebook.admin_users,
--   trusted_routebook.admin_sessions, trusted_routebook.admin_audit, trusted_routebook.admin_invite_codes,
--   trusted_routebook.admin_corrections, trusted_routebook.admin_quota_resets;
-- alter table trusted_routebook.enrich_reports drop column if exists status, drop column if exists resolved_by, drop column if exists resolved_at;

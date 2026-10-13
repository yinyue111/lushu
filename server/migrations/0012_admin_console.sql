-- Admin console phase 1 (docs/admin.md). Additive only: new tables + one nullable-default column.
-- Rolling back: server/migrations/down/0012_admin_console.down.sql (tables are left in place, unused).

-- Runtime config versions. Each save writes a full snapshot of overrides (non-secret values in
-- `overrides`, API keys AES-GCM encrypted in `secrets`). The newest row is the live config.
-- Keys missing from `overrides` fall back to env defaults.
create table if not exists trusted_routebook.admin_config_versions (
  version integer primary key,
  overrides jsonb not null default '{}'::jsonb,
  secrets jsonb not null default '{}'::jsonb,
  changes jsonb not null default '[]'::jsonb,
  actor text not null,
  note text not null default '',
  restored_from integer,
  created_at timestamptz not null default clock_timestamp()
);

-- Admin accounts: separate from user accounts. Password (scrypt) + TOTP second factor.
create table if not exists trusted_routebook.admin_users (
  id text primary key,
  username text not null unique,
  password_hash text not null,
  totp_secret_enc text not null,
  role text not null check (role in ('operator', 'admin')),
  status text not null default 'active' check (status in ('active', 'disabled')),
  last_totp_step bigint not null default 0,
  created_at timestamptz not null default clock_timestamp(),
  last_login_at timestamptz
);

create table if not exists trusted_routebook.admin_sessions (
  sid_hash text primary key,
  admin_id text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists admin_sessions_admin_idx on trusted_routebook.admin_sessions (admin_id);

-- Every admin console write (who / when / what). Never contains secrets, passwords or recovery codes.
create table if not exists trusted_routebook.admin_audit (
  id text primary key,
  actor text not null,
  role text not null default '',
  action text not null,
  target text not null default '',
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists admin_audit_created_idx on trusted_routebook.admin_audit (created_at desc);

-- Invite codes (REGISTRATION_MODE=invite). Only a hash is stored; the code is shown once at creation.
create table if not exists trusted_routebook.admin_invite_codes (
  id text primary key,
  code_hash text not null unique,
  label text not null default '',
  created_by text not null,
  created_at timestamptz not null default clock_timestamp(),
  revoked_at timestamptz
);

-- Operator corrections of enriched fields (reset to 待确认 / set verified value with source URL).
create table if not exists trusted_routebook.admin_corrections (
  id text primary key,
  routebook_id text not null,
  stop_key text not null,
  field text not null,
  action text not null check (action in ('reset', 'verify')),
  value text not null default '',
  source_url text not null default '',
  report_id text,
  actor text not null,
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists admin_corrections_routebook_idx on trusted_routebook.admin_corrections (routebook_id);

-- Quota resets: generations before reset_at no longer count against this profile's window quota.
create table if not exists trusted_routebook.admin_quota_resets (
  profile_id text primary key,
  reset_at timestamptz not null,
  actor text not null
);

-- Report queue state on the existing user-report table.
alter table trusted_routebook.enrich_reports add column if not exists status text not null default 'open';
alter table trusted_routebook.enrich_reports add column if not exists resolved_by text;
alter table trusted_routebook.enrich_reports add column if not exists resolved_at timestamptz;

update trusted_routebook.storage_state
set
  schema_version = 12,
  updated_at = clock_timestamp()
where singleton_id = 1
  and schema_version < 12;

-- Phone + password accounts. Additive only: no existing table or stream changes, no parity reset.
-- Rolling back is AUTH_MODE=access-code; these tables are then simply unused.
-- Phone numbers are never stored: phone_hash is an HMAC (AUTH_PHONE_HASH_SECRET), phone_masked is for display.

create table if not exists trusted_routebook.auth_users (
  id text primary key,
  phone_hash text not null,
  phone_masked text not null,
  phone_last4 text not null default '',
  password_hash text not null,
  recovery_hashes jsonb not null default '[]'::jsonb,
  primary_profile_id text not null,
  status text not null default 'active' check (status in ('active', 'disabled', 'deleted')),
  generation_quota integer,
  credentials_changed_at timestamptz not null default clock_timestamp(),
  last_login_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
-- A phone can belong to one live account; deleted accounts free the number.
create unique index if not exists auth_users_phone_hash_live_uidx on trusted_routebook.auth_users (phone_hash) where status <> 'deleted';
create index if not exists auth_users_phone_last4_idx on trusted_routebook.auth_users (phone_last4);
create unique index if not exists auth_users_primary_profile_uidx on trusted_routebook.auth_users (primary_profile_id) where status <> 'deleted';

create table if not exists trusted_routebook.auth_sessions (
  sid_hash text primary key,
  user_id text not null references trusted_routebook.auth_users (id) on delete cascade,
  created_at timestamptz not null default clock_timestamp(),
  last_seen_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  absolute_expires_at timestamptz not null,
  revoked_at timestamptz,
  user_agent text not null default ''
);
create index if not exists auth_sessions_user_idx on trusted_routebook.auth_sessions (user_id) where revoked_at is null;
create index if not exists auth_sessions_expiry_idx on trusted_routebook.auth_sessions (absolute_expires_at);

-- Persistent throttles: key is 'phone:<hmac>' or 'ip:<hmac of client key>' (no raw IPs or phones).
create table if not exists trusted_routebook.auth_throttles (
  key text primary key,
  failures integer not null default 0,
  window_started_at timestamptz not null default clock_timestamp(),
  locked_until timestamptz,
  lock_level integer not null default 0,
  updated_at timestamptz not null default clock_timestamp()
);

-- Device profiles claimed into an account (the primary profile is on auth_users).
create table if not exists trusted_routebook.auth_profile_links (
  profile_id text primary key,
  user_id text not null references trusted_routebook.auth_users (id) on delete cascade,
  linked_at timestamptz not null default clock_timestamp(),
  via text not null default 'claim'
);
create index if not exists auth_profile_links_user_idx on trusted_routebook.auth_profile_links (user_id);

-- Ops actions on accounts reuse the ops-audits stream; nothing else to add.

update trusted_routebook.storage_state
set
  schema_version = 8,
  updated_at = clock_timestamp()
where singleton_id = 1
  and schema_version < 8;

-- Email for accounts: verification codes, login by email, password reset by email.
-- Additive: new nullable columns and one new table. Phone becomes optional for new accounts
-- (dropping NOT NULL only relaxes a constraint; existing rows are untouched).
-- Rolling back is AUTH_MODE=access-code (or the previous build): the new columns/table are simply unused.
-- Emails are never stored in plain text: email_hash is an HMAC (AUTH_EMAIL_HASH_SECRET), email_enc is
-- AES-256-GCM (AUTH_EMAIL_ENC_KEY), email_masked is for display.

alter table trusted_routebook.auth_users add column if not exists email_hash text;
alter table trusted_routebook.auth_users add column if not exists email_enc text;
alter table trusted_routebook.auth_users add column if not exists email_masked text not null default '';
alter table trusted_routebook.auth_users add column if not exists email_verified_at timestamptz;
alter table trusted_routebook.auth_users alter column phone_hash drop not null;
alter table trusted_routebook.auth_users alter column phone_masked set default '';

-- One live account per email; deleted accounts free the address.
create unique index if not exists auth_users_email_hash_live_uidx
  on trusted_routebook.auth_users (email_hash) where status <> 'deleted' and email_hash is not null;

-- One-time email codes (register / reset / change). Only an HMAC of the code is stored.
create table if not exists trusted_routebook.auth_email_codes (
  id text primary key,
  purpose text not null check (purpose in ('register', 'reset', 'change')),
  email_hash text not null,
  email_enc text not null default '',
  user_id text references trusted_routebook.auth_users (id) on delete cascade,
  code_hash text not null,
  attempts integer not null default 0,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists auth_email_codes_lookup_idx on trusted_routebook.auth_email_codes (purpose, email_hash, created_at desc);
create index if not exists auth_email_codes_expiry_idx on trusted_routebook.auth_email_codes (expires_at);

update trusted_routebook.storage_state
set
  schema_version = 9,
  updated_at = clock_timestamp()
where singleton_id = 1
  and schema_version < 9;

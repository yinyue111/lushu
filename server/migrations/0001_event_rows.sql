create schema if not exists trusted_routebook;
revoke all on schema trusted_routebook from public;

comment on schema trusted_routebook is
  'Trusted Routebook PostgreSQL authority. JSONL is accepted only for one-time migration input and rollback export.';

create table if not exists trusted_routebook.schema_migrations (
  migration_name text not null,
  migration_sha256 text not null,
  applied_at timestamptz not null default clock_timestamp(),
  constraint schema_migrations_pkey primary key (migration_name),
  constraint schema_migrations_name_check check (btrim(migration_name) <> ''),
  constraint schema_migrations_sha256_check check (migration_sha256 ~ '^[0-9a-f]{64}$')
);

create table if not exists trusted_routebook.event_rows (
  id bigint generated always as identity,
  stream text not null,
  ordinal bigint not null,
  payload jsonb not null,
  payload_sha256 text not null,
  inserted_at timestamptz not null default clock_timestamp(),
  constraint event_rows_pkey primary key (id),
  constraint event_rows_stream_ordinal_key unique (stream, ordinal),
  constraint event_rows_stream_check check (
    stream in (
      'ai-logs',
      'checkins',
      'clicks',
      'exposures',
      'routebooks',
      'routebook-audits',
      'profiles',
      'profile-lifecycle',
      'poi-corrections',
      'poi-knowledge',
      'pois',
      'reviews',
      'imports',
      'favorites',
      'checkin-photos'
    )
  ),
  constraint event_rows_ordinal_check check (ordinal > 0),
  constraint event_rows_payload_object_check check (jsonb_typeof(payload) = 'object'),
  constraint event_rows_payload_sha256_check check (payload_sha256 ~ '^[0-9a-f]{64}$')
);

create index if not exists event_rows_stream_recent_idx
  on trusted_routebook.event_rows (stream, ordinal desc);

create table if not exists trusted_routebook.config_documents (
  name text not null,
  document jsonb not null,
  document_sha256 text not null,
  revision bigint not null default 1,
  updated_at timestamptz not null default clock_timestamp(),
  constraint config_documents_pkey primary key (name),
  constraint config_documents_name_check check (
    name in ('cms-config', 'product-config')
  ),
  constraint config_documents_object_check check (jsonb_typeof(document) = 'object'),
  constraint config_documents_sha256_check check (document_sha256 ~ '^[0-9a-f]{64}$'),
  constraint config_documents_revision_check check (revision > 0)
);

create table if not exists trusted_routebook.storage_state (
  singleton_id smallint not null default 1,
  schema_version integer not null default 1,
  phase text not null default 'empty',
  cutover_ready boolean not null default false,
  source_manifest_sha256 text,
  source_manifest jsonb,
  parity_report jsonb,
  backfilled_at timestamptz,
  parity_checked_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  constraint storage_state_pkey primary key (singleton_id),
  constraint storage_state_singleton_check check (singleton_id = 1),
  constraint storage_state_schema_version_check check (schema_version > 0),
  constraint storage_state_phase_check check (phase in ('empty', 'backfilled', 'ready')),
  constraint storage_state_manifest_sha256_check check (
    source_manifest_sha256 is null or source_manifest_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint storage_state_source_manifest_check check (
    source_manifest is null or jsonb_typeof(source_manifest) = 'object'
  ),
  constraint storage_state_parity_report_check check (
    parity_report is null or jsonb_typeof(parity_report) = 'object'
  ),
  constraint storage_state_ready_check check (
    not cutover_ready or (
      phase = 'ready' and
      source_manifest_sha256 is not null and
      source_manifest is not null and
      parity_report is not null and
      backfilled_at is not null and
      parity_checked_at is not null
    )
  )
);

insert into trusted_routebook.storage_state (singleton_id)
values (1)
on conflict (singleton_id) do nothing;

comment on table trusted_routebook.event_rows is
  'Append-ordered authoritative rows for the 15 historical JSONL streams. No runtime dual-write or JSONL fallback is permitted.';
comment on column trusted_routebook.event_rows.ordinal is
  'Monotonic position within one stream. Runtime writes serialize ordinal allocation with PostgreSQL advisory locks.';
comment on table trusted_routebook.config_documents is
  'Authoritative PostgreSQL copies of cms-config.json and product-config.json after cutover.';
comment on table trusted_routebook.storage_state is
  'Readiness gate: only an exact backfill plus parity pass may set cutover_ready=true.';

revoke all on all tables in schema trusted_routebook from public;
revoke all on all sequences in schema trusted_routebook from public;
revoke all on all functions in schema trusted_routebook from public;

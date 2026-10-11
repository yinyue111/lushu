-- Background fact enrichment (ticket price / 免费, opening hours). Additive only.
-- Rolling back is ENRICH_ENABLED=false; these tables are then simply unused.

-- Persistent work queue: one job per routebook; survives restarts (running jobs past their lease are retried).
create table if not exists trusted_routebook.enrich_jobs (
  routebook_id text primary key,
  user_id text not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed', 'skipped')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default clock_timestamp(),
  lease_until timestamptz,
  last_error text not null default '',
  summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create index if not exists enrich_jobs_due_idx on trusted_routebook.enrich_jobs (status, next_attempt_at);

-- Per-routebook result: per-stop claims with provenance (value, sources, retrievedAt, method).
create table if not exists trusted_routebook.enrich_results (
  routebook_id text primary key,
  claims jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default clock_timestamp()
);

-- Shared cache per city + place + field (filled or not), so popular places are looked up once.
create table if not exists trusted_routebook.enrich_cache (
  key text primary key,
  entry jsonb not null,
  expires_at timestamptz not null
);
create index if not exists enrich_cache_expiry_idx on trusted_routebook.enrich_cache (expires_at);

-- Spend per UTC day, for the global daily budget and ops stats.
create table if not exists trusted_routebook.enrich_spend (
  day date primary key,
  usd numeric not null default 0,
  searches integer not null default 0,
  pages integer not null default 0,
  amap_calls integer not null default 0
);

-- "This is wrong" reports from users.
create table if not exists trusted_routebook.enrich_reports (
  id text primary key,
  routebook_id text not null,
  stop_key text not null,
  field text not null,
  cache_key text not null default '',
  note text not null default '',
  user_id text,
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists enrich_reports_created_idx on trusted_routebook.enrich_reports (created_at desc);

update trusted_routebook.storage_state
set
  schema_version = 10,
  updated_at = clock_timestamp()
where singleton_id = 1
  and schema_version < 10;

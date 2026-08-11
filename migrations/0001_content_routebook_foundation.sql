\set ON_ERROR_STOP on

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- JSONL remains the runtime source of truth. This schema is a migration target
-- only and must not be selected by STORAGE_BACKEND until an adapter, parity
-- checks, rollback behavior, and readiness probes have been completed.
create schema if not exists trusted_routebook;
revoke all on schema trusted_routebook from public;

comment on schema trusted_routebook is
  'Future PostgreSQL storage for Trusted Routebook. JSONL remains authoritative until adapter parity and readiness gates pass.';

create table if not exists trusted_routebook.profiles (
  id bigint generated always as identity,
  public_id text not null,
  display_name text not null default '',
  identity_status text not null default 'unbound',
  access_token_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_pkey primary key (id),
  constraint profiles_public_id_key unique (public_id),
  constraint profiles_public_id_check check (
    public_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  constraint profiles_identity_status_check check (
    identity_status in ('unbound', 'owned', 'attested', 'revoked')
  ),
  constraint profiles_access_token_hash_check check (
    access_token_hash is null or access_token_hash ~ '^[0-9a-f]{64}$'
  )
);

create table if not exists trusted_routebook.content_import_batches (
  id bigint generated always as identity,
  public_id text not null,
  idempotency_key text not null,
  source_type text not null,
  status text not null default 'validating',
  payload_sha256 text not null,
  source_row_count bigint not null default 0,
  valid_row_count bigint not null default 0,
  invalid_row_count bigint not null default 0,
  committed_row_count bigint not null default 0,
  summary jsonb not null default '{}'::jsonb,
  created_by_profile_id bigint,
  created_at timestamptz not null default now(),
  validated_at timestamptz,
  committed_at timestamptz,
  failed_at timestamptz,
  constraint content_import_batches_pkey primary key (id),
  constraint content_import_batches_public_id_key unique (public_id),
  constraint content_import_batches_idempotency_key_key unique (idempotency_key),
  constraint content_import_batches_public_id_check check (
    public_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  constraint content_import_batches_source_type_check check (
    source_type in ('csv', 'json', 'api', 'manual', 'jsonl-migration')
  ),
  constraint content_import_batches_status_check check (
    status in ('validating', 'validated', 'committing', 'committed', 'failed')
  ),
  constraint content_import_batches_payload_sha256_check check (
    payload_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint content_import_batches_counts_check check (
    source_row_count >= 0 and
    valid_row_count >= 0 and
    invalid_row_count >= 0 and
    committed_row_count >= 0 and
    valid_row_count + invalid_row_count <= source_row_count and
    committed_row_count <= valid_row_count
  ),
  constraint content_import_batches_summary_object_check check (
    jsonb_typeof(summary) = 'object'
  ),
  constraint content_import_batches_created_by_fkey foreign key (created_by_profile_id)
    references trusted_routebook.profiles (id) on delete restrict
);

create table if not exists trusted_routebook.pois (
  id bigint generated always as identity,
  public_id text not null,
  city text not null,
  name text not null,
  normalized_name text not null,
  aliases text[] not null default '{}'::text[],
  category text not null default 'other',
  lifecycle_status text not null default 'unknown',
  review_status text not null default 'pending',
  latitude double precision,
  longitude double precision,
  coordinate_system text not null default 'WGS84',
  coordinate_source text not null default 'unknown',
  coordinate_precision text not null default 'unknown',
  coordinate_confidence smallint,
  coordinate_radius_meters integer,
  navigation_disabled boolean not null default true,
  version bigint not null default 1,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pois_pkey primary key (id),
  constraint pois_public_id_key unique (public_id),
  constraint pois_city_normalized_name_key unique (city, normalized_name),
  constraint pois_public_id_check check (
    public_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  constraint pois_city_check check (btrim(city) <> ''),
  constraint pois_name_check check (btrim(name) <> ''),
  constraint pois_normalized_name_check check (btrim(normalized_name) <> ''),
  constraint pois_lifecycle_status_check check (
    lifecycle_status in ('active', 'temporarily_closed', 'closed', 'unknown')
  ),
  constraint pois_review_status_check check (
    review_status in ('pending', 'approved', 'rejected', 'archived')
  ),
  constraint pois_coordinate_pair_check check (
    (latitude is null and longitude is null) or
    (latitude is not null and longitude is not null)
  ),
  constraint pois_latitude_check check (
    latitude is null or latitude between -90 and 90
  ),
  constraint pois_longitude_check check (
    longitude is null or longitude between -180 and 180
  ),
  constraint pois_coordinate_confidence_check check (
    coordinate_confidence is null or coordinate_confidence between 0 and 100
  ),
  constraint pois_coordinate_radius_check check (
    coordinate_radius_meters is null or coordinate_radius_meters >= 0
  ),
  constraint pois_version_check check (version > 0)
);

create table if not exists trusted_routebook.poi_evidence (
  id bigint generated always as identity,
  public_id text not null,
  poi_id bigint not null,
  import_batch_id bigint,
  kind text not null,
  source_label text not null,
  source_url text,
  excerpt text not null default '',
  content_sha256 text,
  visibility text not null default 'private',
  review_status text not null default 'pending',
  reviewed_by_profile_id bigint,
  captured_at timestamptz,
  checked_at timestamptz,
  expires_at timestamptz,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint poi_evidence_pkey primary key (id),
  constraint poi_evidence_public_id_key unique (public_id),
  constraint poi_evidence_poi_id_id_key unique (poi_id, id),
  constraint poi_evidence_public_id_check check (
    public_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  constraint poi_evidence_kind_check check (
    kind in ('official', 'operator', 'imported', 'user_correction', 'checkin')
  ),
  constraint poi_evidence_source_label_check check (btrim(source_label) <> ''),
  constraint poi_evidence_content_sha256_check check (
    content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint poi_evidence_visibility_check check (
    visibility in ('private', 'public')
  ),
  constraint poi_evidence_review_status_check check (
    review_status in ('pending', 'approved', 'rejected', 'superseded')
  ),
  constraint poi_evidence_expiry_check check (
    expires_at is null or
    checked_at is null or
    expires_at > checked_at
  ),
  constraint poi_evidence_poi_fkey foreign key (poi_id)
    references trusted_routebook.pois (id) on delete restrict,
  constraint poi_evidence_import_batch_fkey foreign key (import_batch_id)
    references trusted_routebook.content_import_batches (id) on delete restrict,
  constraint poi_evidence_reviewer_fkey foreign key (reviewed_by_profile_id)
    references trusted_routebook.profiles (id) on delete restrict
);

create table if not exists trusted_routebook.poi_facts (
  id bigint generated always as identity,
  public_id text not null,
  poi_id bigint not null,
  field text not null,
  value jsonb not null,
  value_summary text not null default '',
  origin text not null,
  review_status text not null default 'pending',
  confidence smallint,
  version bigint not null default 1,
  supersedes_fact_id bigint,
  reviewed_by_profile_id bigint,
  checked_at timestamptz,
  expires_at timestamptz,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint poi_facts_pkey primary key (id),
  constraint poi_facts_public_id_key unique (public_id),
  constraint poi_facts_poi_id_id_key unique (poi_id, id),
  constraint poi_facts_poi_field_version_key unique (poi_id, field, version),
  constraint poi_facts_public_id_check check (
    public_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  constraint poi_facts_field_check check (
    field in (
      'open_hours',
      'price',
      'reservation',
      'recommended_stay',
      'audience',
      'risk',
      'lifecycle_status',
      'coordinates',
      'queue',
      'crowd',
      'accessibility',
      'other'
    )
  ),
  constraint poi_facts_origin_check check (
    origin in ('operator', 'imported', 'correction', 'derived')
  ),
  constraint poi_facts_review_status_check check (
    review_status in ('pending', 'approved', 'rejected', 'superseded')
  ),
  constraint poi_facts_confidence_check check (
    confidence is null or confidence between 0 and 100
  ),
  constraint poi_facts_version_check check (version > 0),
  constraint poi_facts_expiry_check check (
    expires_at is null or
    checked_at is null or
    expires_at > checked_at
  ),
  constraint poi_facts_poi_fkey foreign key (poi_id)
    references trusted_routebook.pois (id) on delete restrict,
  constraint poi_facts_supersedes_fkey foreign key (supersedes_fact_id)
    references trusted_routebook.poi_facts (id) on delete restrict,
  constraint poi_facts_reviewer_fkey foreign key (reviewed_by_profile_id)
    references trusted_routebook.profiles (id) on delete restrict
);

create table if not exists trusted_routebook.poi_fact_evidence (
  poi_id bigint not null,
  poi_fact_id bigint not null,
  poi_evidence_id bigint not null,
  created_at timestamptz not null default now(),
  constraint poi_fact_evidence_pkey primary key (poi_fact_id, poi_evidence_id),
  constraint poi_fact_evidence_fact_poi_fkey foreign key (poi_id, poi_fact_id)
    references trusted_routebook.poi_facts (poi_id, id) on delete restrict,
  constraint poi_fact_evidence_evidence_poi_fkey foreign key (poi_id, poi_evidence_id)
    references trusted_routebook.poi_evidence (poi_id, id) on delete restrict
);

create table if not exists trusted_routebook.poi_corrections (
  id bigint generated always as identity,
  public_id text not null,
  poi_id bigint,
  submitted_by_profile_id bigint,
  city text not null,
  stop_name text not null,
  field text not null,
  current_value text not null default '',
  suggested_value text not null,
  reason text not null default '',
  source_url text,
  status text not null default 'pending',
  reviewer_note text not null default '',
  reviewed_by_profile_id bigint,
  accepted_fact_id bigint,
  accepted_evidence_id bigint,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint poi_corrections_pkey primary key (id),
  constraint poi_corrections_public_id_key unique (public_id),
  constraint poi_corrections_public_id_check check (
    public_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  constraint poi_corrections_legacy_locator_check check (
    poi_id is not null or (btrim(city) <> '' and btrim(stop_name) <> '')
  ),
  constraint poi_corrections_field_check check (btrim(field) <> ''),
  constraint poi_corrections_suggested_value_check check (btrim(suggested_value) <> ''),
  constraint poi_corrections_status_check check (
    status in ('pending', 'approved', 'rejected', 'superseded')
  ),
  constraint poi_corrections_version_check check (version > 0),
  constraint poi_corrections_acceptance_check check (
    status = 'approved' or
    (accepted_fact_id is null and accepted_evidence_id is null)
  ),
  constraint poi_corrections_poi_fkey foreign key (poi_id)
    references trusted_routebook.pois (id) on delete restrict,
  constraint poi_corrections_submitter_fkey foreign key (submitted_by_profile_id)
    references trusted_routebook.profiles (id) on delete restrict,
  constraint poi_corrections_reviewer_fkey foreign key (reviewed_by_profile_id)
    references trusted_routebook.profiles (id) on delete restrict,
  constraint poi_corrections_accepted_fact_fkey foreign key (accepted_fact_id)
    references trusted_routebook.poi_facts (id) on delete restrict,
  constraint poi_corrections_accepted_evidence_fkey foreign key (accepted_evidence_id)
    references trusted_routebook.poi_evidence (id) on delete restrict
);

create table if not exists trusted_routebook.poi_review_events (
  id bigint generated always as identity,
  public_id text not null,
  poi_id bigint not null,
  correction_id bigint,
  evidence_id bigint,
  fact_id bigint,
  actor_profile_id bigint,
  event_type text not null,
  from_status text,
  to_status text,
  note text not null default '',
  request_id text,
  entity_version bigint,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint poi_review_events_pkey primary key (id),
  constraint poi_review_events_public_id_key unique (public_id),
  constraint poi_review_events_public_id_check check (
    public_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  constraint poi_review_events_event_type_check check (
    event_type in (
      'submitted',
      'approved',
      'rejected',
      'superseded',
      'expired',
      'import_validated',
      'import_committed'
    )
  ),
  constraint poi_review_events_from_status_check check (
    from_status is null or from_status in ('pending', 'approved', 'rejected', 'superseded')
  ),
  constraint poi_review_events_to_status_check check (
    to_status is null or to_status in ('pending', 'approved', 'rejected', 'superseded')
  ),
  constraint poi_review_events_entity_version_check check (
    entity_version is null or entity_version > 0
  ),
  constraint poi_review_events_metadata_object_check check (
    jsonb_typeof(metadata) = 'object'
  ),
  constraint poi_review_events_poi_fkey foreign key (poi_id)
    references trusted_routebook.pois (id) on delete restrict,
  constraint poi_review_events_correction_fkey foreign key (correction_id)
    references trusted_routebook.poi_corrections (id) on delete restrict,
  constraint poi_review_events_evidence_fkey foreign key (evidence_id)
    references trusted_routebook.poi_evidence (id) on delete restrict,
  constraint poi_review_events_fact_fkey foreign key (fact_id)
    references trusted_routebook.poi_facts (id) on delete restrict,
  constraint poi_review_events_actor_fkey foreign key (actor_profile_id)
    references trusted_routebook.profiles (id) on delete restrict
);

-- The version pointers are added before routebook_versions exists, then bound
-- through deferred composite foreign keys after the version table is created.
create table if not exists trusted_routebook.routebooks (
  id bigint generated always as identity,
  public_id text not null,
  owner_profile_id bigint,
  city text not null,
  title text not null,
  summary text not null default '',
  publish_status text not null default 'draft',
  source_authorization text not null default 'user-generated',
  current_version_id bigint,
  published_version_id bigint,
  edit_token_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz,
  archived_at timestamptz,
  constraint routebooks_pkey primary key (id),
  constraint routebooks_public_id_key unique (public_id),
  constraint routebooks_public_id_check check (
    public_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  constraint routebooks_city_check check (btrim(city) <> ''),
  constraint routebooks_title_check check (btrim(title) <> ''),
  constraint routebooks_publish_status_check check (
    publish_status in ('draft', 'published', 'featured', 'archived')
  ),
  constraint routebooks_source_authorization_check check (
    source_authorization in ('self-owned', 'user-generated', 'affiliate-link', 'imported-authorized')
  ),
  constraint routebooks_edit_token_hash_check check (
    edit_token_hash is null or edit_token_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint routebooks_published_version_state_check check (
    publish_status not in ('published', 'featured') or published_version_id is not null
  ),
  constraint routebooks_owner_fkey foreign key (owner_profile_id)
    references trusted_routebook.profiles (id) on delete restrict
);

create table if not exists trusted_routebook.routebook_versions (
  id bigint generated always as identity,
  public_id text not null,
  routebook_id bigint not null,
  version bigint not null,
  parent_version_id bigint,
  snapshot jsonb not null,
  snapshot_sha256 text not null,
  created_by_profile_id bigint,
  created_at timestamptz not null default now(),
  constraint routebook_versions_pkey primary key (id),
  constraint routebook_versions_public_id_key unique (public_id),
  constraint routebook_versions_routebook_version_key unique (routebook_id, version),
  constraint routebook_versions_routebook_id_id_key unique (routebook_id, id),
  constraint routebook_versions_public_id_check check (
    public_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  constraint routebook_versions_version_check check (version > 0),
  constraint routebook_versions_snapshot_object_check check (
    jsonb_typeof(snapshot) = 'object'
  ),
  constraint routebook_versions_snapshot_sha256_check check (
    snapshot_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint routebook_versions_routebook_fkey foreign key (routebook_id)
    references trusted_routebook.routebooks (id) on delete restrict,
  constraint routebook_versions_parent_fkey foreign key (routebook_id, parent_version_id)
    references trusted_routebook.routebook_versions (routebook_id, id)
    on delete restrict deferrable initially deferred,
  constraint routebook_versions_creator_fkey foreign key (created_by_profile_id)
    references trusted_routebook.profiles (id) on delete restrict
);

-- Rebuild this check on every run so databases that applied an earlier version
-- of the foundation migration receive the tightened credential-key policy.
alter table trusted_routebook.routebook_versions
  drop constraint if exists routebook_versions_snapshot_no_credentials_check;

alter table trusted_routebook.routebook_versions
  add constraint routebook_versions_snapshot_no_credentials_check check (
    snapshot::text !~* '"([A-Za-z0-9._ -]*(token|api[_ -]?key|private[_ -]?key|secret|password|passwd|passphrase)|authorization)"[[:space:]]*:'
  );

do $migration$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'routebooks_current_version_fkey'
      and conrelid = 'trusted_routebook.routebooks'::regclass
  ) then
    alter table trusted_routebook.routebooks
      add constraint routebooks_current_version_fkey
      foreign key (id, current_version_id)
      references trusted_routebook.routebook_versions (routebook_id, id)
      on delete no action deferrable initially deferred;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'routebooks_published_version_fkey'
      and conrelid = 'trusted_routebook.routebooks'::regclass
  ) then
    alter table trusted_routebook.routebooks
      add constraint routebooks_published_version_fkey
      foreign key (id, published_version_id)
      references trusted_routebook.routebook_versions (routebook_id, id)
      on delete no action deferrable initially deferred;
  end if;
end
$migration$;

create or replace function trusted_routebook.reject_routebook_version_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, trusted_routebook
as $function$
begin
  raise exception using
    errcode = '55000',
    message = 'routebook_versions rows are immutable';
end
$function$;

do $migration$
begin
  if not exists (
    select 1
    from pg_trigger
    where tgname = 'routebook_versions_immutable_trigger'
      and tgrelid = 'trusted_routebook.routebook_versions'::regclass
      and not tgisinternal
  ) then
    execute 'create trigger routebook_versions_immutable_trigger
      before update or delete on trusted_routebook.routebook_versions
      for each row execute function trusted_routebook.reject_routebook_version_mutation()';
  end if;
end
$migration$;

create table if not exists trusted_routebook.routebook_status_events (
  id bigint generated always as identity,
  public_id text not null,
  routebook_id bigint not null,
  routebook_version_id bigint,
  actor_profile_id bigint,
  from_status text,
  to_status text not null,
  note text not null default '',
  request_id text,
  created_at timestamptz not null default now(),
  constraint routebook_status_events_pkey primary key (id),
  constraint routebook_status_events_public_id_key unique (public_id),
  constraint routebook_status_events_public_id_check check (
    public_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  constraint routebook_status_events_from_status_check check (
    from_status is null or from_status in ('draft', 'published', 'featured', 'archived')
  ),
  constraint routebook_status_events_to_status_check check (
    to_status in ('draft', 'published', 'featured', 'archived')
  ),
  constraint routebook_status_events_routebook_fkey foreign key (routebook_id)
    references trusted_routebook.routebooks (id) on delete restrict,
  constraint routebook_status_events_version_fkey foreign key (routebook_id, routebook_version_id)
    references trusted_routebook.routebook_versions (routebook_id, id)
    on delete restrict deferrable initially deferred,
  constraint routebook_status_events_actor_fkey foreign key (actor_profile_id)
    references trusted_routebook.profiles (id) on delete restrict
);

create table if not exists trusted_routebook.checkins (
  id bigint generated always as identity,
  public_id text not null,
  profile_id bigint not null,
  routebook_id bigint not null,
  routebook_version_id bigint,
  poi_id bigint,
  client_local_id text not null,
  status text not null,
  trust_state text not null,
  worth text,
  gps_latitude double precision,
  gps_longitude double precision,
  gps_accuracy_meters double precision,
  arrival_valid boolean not null default false,
  arrival_confidence text not null default 'unverified',
  feedback jsonb not null default '{}'::jsonb,
  observed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint checkins_pkey primary key (id),
  constraint checkins_public_id_key unique (public_id),
  constraint checkins_profile_routebook_client_local_key unique (
    profile_id,
    routebook_id,
    client_local_id
  ),
  constraint checkins_public_id_check check (
    public_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  constraint checkins_client_local_id_check check (btrim(client_local_id) <> ''),
  constraint checkins_status_check check (
    status in ('visited', 'skipped', 'replaced')
  ),
  constraint checkins_trust_state_check check (
    trust_state in ('anonymous', 'profile-owned', 'profile-attested')
  ),
  constraint checkins_worth_check check (
    worth is null or worth in ('worthwhile', 'average', 'pitfall', 'skipped', 'replaced')
  ),
  constraint checkins_gps_pair_check check (
    (gps_latitude is null and gps_longitude is null) or
    (gps_latitude is not null and gps_longitude is not null)
  ),
  constraint checkins_gps_latitude_check check (
    gps_latitude is null or gps_latitude between -90 and 90
  ),
  constraint checkins_gps_longitude_check check (
    gps_longitude is null or gps_longitude between -180 and 180
  ),
  constraint checkins_gps_accuracy_check check (
    gps_accuracy_meters is null or gps_accuracy_meters >= 0
  ),
  constraint checkins_arrival_confidence_check check (
    arrival_confidence in ('unverified', 'weak', 'valid', 'invalid')
  ),
  constraint checkins_feedback_object_check check (
    jsonb_typeof(feedback) = 'object'
  ),
  constraint checkins_profile_fkey foreign key (profile_id)
    references trusted_routebook.profiles (id) on delete restrict,
  constraint checkins_routebook_fkey foreign key (routebook_id)
    references trusted_routebook.routebooks (id) on delete restrict,
  constraint checkins_routebook_version_fkey foreign key (routebook_id, routebook_version_id)
    references trusted_routebook.routebook_versions (routebook_id, id)
    on delete restrict deferrable initially deferred,
  constraint checkins_poi_fkey foreign key (poi_id)
    references trusted_routebook.pois (id) on delete restrict
);

create table if not exists trusted_routebook.routebook_copy_events (
  id bigint generated always as identity,
  public_id text not null,
  source_routebook_id bigint not null,
  source_version_id bigint,
  copied_routebook_id bigint,
  actor_profile_id bigint,
  actor_session_id text,
  actor_key text not null,
  surface text not null default 'unknown',
  created_at timestamptz not null default now(),
  constraint routebook_copy_events_pkey primary key (id),
  constraint routebook_copy_events_public_id_key unique (public_id),
  constraint routebook_copy_events_source_actor_key unique (source_routebook_id, actor_key),
  constraint routebook_copy_events_public_id_check check (
    public_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  constraint routebook_copy_events_actor_check check (
    actor_profile_id is not null or nullif(btrim(actor_session_id), '') is not null
  ),
  constraint routebook_copy_events_actor_key_check check (btrim(actor_key) <> ''),
  constraint routebook_copy_events_source_routebook_fkey foreign key (source_routebook_id)
    references trusted_routebook.routebooks (id) on delete restrict,
  constraint routebook_copy_events_source_version_fkey foreign key (source_routebook_id, source_version_id)
    references trusted_routebook.routebook_versions (routebook_id, id)
    on delete restrict deferrable initially deferred,
  constraint routebook_copy_events_copied_routebook_fkey foreign key (copied_routebook_id)
    references trusted_routebook.routebooks (id) on delete restrict,
  constraint routebook_copy_events_actor_profile_fkey foreign key (actor_profile_id)
    references trusted_routebook.profiles (id) on delete restrict
);

-- Foreign-key indexes and a deliberately small set of filter/timeline indexes.
create index if not exists content_import_batches_created_by_idx
  on trusted_routebook.content_import_batches (created_by_profile_id)
  where created_by_profile_id is not null;
create index if not exists content_import_batches_active_idx
  on trusted_routebook.content_import_batches (created_at)
  where status in ('validating', 'validated', 'committing');

create index if not exists pois_city_review_status_idx
  on trusted_routebook.pois (city, review_status, updated_at desc);

create index if not exists poi_evidence_poi_review_idx
  on trusted_routebook.poi_evidence (poi_id, review_status, checked_at desc);
create index if not exists poi_evidence_import_batch_idx
  on trusted_routebook.poi_evidence (import_batch_id)
  where import_batch_id is not null;
create index if not exists poi_evidence_reviewer_idx
  on trusted_routebook.poi_evidence (reviewed_by_profile_id)
  where reviewed_by_profile_id is not null;
create index if not exists poi_evidence_pending_created_at_idx
  on trusted_routebook.poi_evidence (created_at)
  where review_status = 'pending';

create index if not exists poi_facts_supersedes_idx
  on trusted_routebook.poi_facts (supersedes_fact_id)
  where supersedes_fact_id is not null;
create index if not exists poi_facts_reviewer_idx
  on trusted_routebook.poi_facts (reviewed_by_profile_id)
  where reviewed_by_profile_id is not null;
create index if not exists poi_facts_expiry_idx
  on trusted_routebook.poi_facts (expires_at, poi_id)
  where review_status = 'approved' and expires_at is not null;
create index if not exists poi_facts_pending_created_at_idx
  on trusted_routebook.poi_facts (created_at)
  where review_status = 'pending';

create index if not exists poi_fact_evidence_evidence_idx
  on trusted_routebook.poi_fact_evidence (poi_evidence_id, poi_fact_id);

create index if not exists poi_corrections_poi_status_idx
  on trusted_routebook.poi_corrections (poi_id, status, created_at desc)
  where poi_id is not null;
create index if not exists poi_corrections_submitter_idx
  on trusted_routebook.poi_corrections (submitted_by_profile_id)
  where submitted_by_profile_id is not null;
create index if not exists poi_corrections_reviewer_idx
  on trusted_routebook.poi_corrections (reviewed_by_profile_id)
  where reviewed_by_profile_id is not null;
create index if not exists poi_corrections_accepted_fact_idx
  on trusted_routebook.poi_corrections (accepted_fact_id)
  where accepted_fact_id is not null;
create index if not exists poi_corrections_accepted_evidence_idx
  on trusted_routebook.poi_corrections (accepted_evidence_id)
  where accepted_evidence_id is not null;
create index if not exists poi_corrections_pending_created_at_idx
  on trusted_routebook.poi_corrections (created_at)
  where status = 'pending';

create index if not exists poi_review_events_poi_timeline_idx
  on trusted_routebook.poi_review_events (poi_id, created_at desc, id desc);
create index if not exists poi_review_events_correction_idx
  on trusted_routebook.poi_review_events (correction_id)
  where correction_id is not null;
create index if not exists poi_review_events_evidence_idx
  on trusted_routebook.poi_review_events (evidence_id)
  where evidence_id is not null;
create index if not exists poi_review_events_fact_idx
  on trusted_routebook.poi_review_events (fact_id)
  where fact_id is not null;
create index if not exists poi_review_events_actor_idx
  on trusted_routebook.poi_review_events (actor_profile_id)
  where actor_profile_id is not null;

create index if not exists routebooks_owner_idx
  on trusted_routebook.routebooks (owner_profile_id)
  where owner_profile_id is not null;
create index if not exists routebooks_city_publish_status_idx
  on trusted_routebook.routebooks (city, publish_status, updated_at desc);
create index if not exists routebooks_current_version_fk_idx
  on trusted_routebook.routebooks (current_version_id, id)
  where current_version_id is not null;
create index if not exists routebooks_published_version_fk_idx
  on trusted_routebook.routebooks (published_version_id, id)
  where published_version_id is not null;

create index if not exists routebook_versions_parent_idx
  on trusted_routebook.routebook_versions (parent_version_id, routebook_id)
  where parent_version_id is not null;
create index if not exists routebook_versions_creator_idx
  on trusted_routebook.routebook_versions (created_by_profile_id)
  where created_by_profile_id is not null;
create index if not exists routebook_versions_timeline_idx
  on trusted_routebook.routebook_versions (routebook_id, created_at desc, id desc);

create index if not exists routebook_status_events_timeline_idx
  on trusted_routebook.routebook_status_events (routebook_id, created_at desc, id desc);
create index if not exists routebook_status_events_version_idx
  on trusted_routebook.routebook_status_events (routebook_version_id, routebook_id)
  where routebook_version_id is not null;
create index if not exists routebook_status_events_actor_idx
  on trusted_routebook.routebook_status_events (actor_profile_id)
  where actor_profile_id is not null;

create index if not exists checkins_routebook_timeline_idx
  on trusted_routebook.checkins (routebook_id, created_at desc, id desc);
create index if not exists checkins_routebook_version_idx
  on trusted_routebook.checkins (routebook_version_id, routebook_id)
  where routebook_version_id is not null;
create index if not exists checkins_poi_timeline_idx
  on trusted_routebook.checkins (poi_id, created_at desc, id desc)
  where poi_id is not null;

create index if not exists routebook_copy_events_source_version_idx
  on trusted_routebook.routebook_copy_events (source_version_id, source_routebook_id)
  where source_version_id is not null;
create index if not exists routebook_copy_events_copied_routebook_idx
  on trusted_routebook.routebook_copy_events (copied_routebook_id)
  where copied_routebook_id is not null;
create index if not exists routebook_copy_events_actor_profile_idx
  on trusted_routebook.routebook_copy_events (actor_profile_id)
  where actor_profile_id is not null;

comment on table trusted_routebook.content_import_batches is
  'Idempotent validate/commit boundary. Validate externally, then use short transactions and INSERT ON CONFLICT against stable unique keys.';
comment on table trusted_routebook.poi_facts is
  'Normalized POI facts. Only approved facts linked to reviewed evidence and not expired count toward operational coverage.';
comment on table trusted_routebook.routebooks is
  'Mutable routebook head. Store only an edit-token hash; never persist the raw editToken in PostgreSQL.';
comment on column trusted_routebook.routebooks.edit_token_hash is
  'One-way hash of the route edit token. Raw editToken values must never be imported.';
comment on table trusted_routebook.routebook_versions is
  'Immutable routebook JSON snapshots. JSONL history imports map oldest-to-newest to versions 1..n and strip private tokens before hashing.';
comment on column trusted_routebook.routebook_versions.snapshot is
  'Public/domain snapshot only. The adapter must recursively remove editToken, access tokens, and other credentials before insert.';

-- PostgreSQL is not the runtime backend yet. During a future JSONL import:
-- 1. import each routebook history oldest-to-newest as version 1..n;
-- 2. strip editToken from every snapshot and persist only edit_token_hash;
-- 3. set current_version_id/published_version_id after version rows exist;
-- 4. preserve legacy public IDs and derive deterministic idempotency keys;
-- 5. compare JSONL/PostgreSQL reads before enabling readiness or writes.
--
-- Deployment owns role creation. Use separate NOLOGIN capability roles and a
-- pooled LOGIN role with only the table/sequence grants required by the
-- adapter. This migration intentionally creates no role, login, or password.
revoke all on all tables in schema trusted_routebook from public;
revoke all on all sequences in schema trusted_routebook from public;
revoke all on all functions in schema trusted_routebook from public;

commit;

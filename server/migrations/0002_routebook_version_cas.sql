alter table trusted_routebook.event_rows
  add column if not exists routebook_version_enforced boolean not null default true;

with ranked_routebook_versions as (
  select
    id,
    row_number() over (
      partition by
        coalesce(payload->>'publicId', payload->>'id'),
        (payload->>'version')::numeric
      order by ordinal desc, id desc
    ) as duplicate_rank
  from trusted_routebook.event_rows
  where stream = 'routebooks'
    and nullif(btrim(coalesce(payload->>'publicId', payload->>'id')), '') is not null
    and jsonb_typeof(payload->'version') = 'number'
    and (payload->>'version')::numeric > 0
    and trunc((payload->>'version')::numeric) = (payload->>'version')::numeric
)
update trusted_routebook.event_rows as event_row
set routebook_version_enforced = ranked.duplicate_rank = 1
from ranked_routebook_versions as ranked
where event_row.id = ranked.id;

create unique index if not exists event_rows_routebook_entity_version_uidx
  on trusted_routebook.event_rows (
    (coalesce(payload->>'publicId', payload->>'id')),
    (((payload->>'version')::numeric))
  )
  where stream = 'routebooks'
    and routebook_version_enforced
    and nullif(btrim(coalesce(payload->>'publicId', payload->>'id')), '') is not null
    and jsonb_typeof(payload->'version') = 'number'
    and (payload->>'version')::numeric > 0
    and trunc((payload->>'version')::numeric) = (payload->>'version')::numeric;

comment on index trusted_routebook.event_rows_routebook_entity_version_uidx is
  'Final CAS guard: one positive integer version per routebook publicId/id in the routebooks stream.';

comment on column trusted_routebook.event_rows.routebook_version_enforced is
  'False only for superseded historical duplicate versions retained during migration; runtime inserts default to enforced.';

update trusted_routebook.storage_state
set
  schema_version = 2,
  updated_at = clock_timestamp()
where singleton_id = 1
  and schema_version < 2;

import {
  CONFIG_DOCUMENTS,
  EVENT_STREAMS,
  POSTGRES_SCHEMA,
  POSTGRES_STORAGE_SCHEMA_VERSION,
  assertConfigDocumentName,
  assertEventStreamName,
  requirePostgresStorageBackend,
  storageContractError
} from './storage/contract.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { jsonSha256, normalizeJsonObject } from './storage/jsonCanonical.mjs';
import { createPostgresPool, withPostgresTransaction } from './storage/postgresConnection.mjs';
import { profileIdSecretFingerprint } from './storage/routebookCredentials.mjs';
import { buildStorageSnapshot, compareStorageSnapshots } from './storage/snapshot.mjs';
import { encodeEntityKey, entityKeyFunctionForStream, secondaryKeyFunction, storedEntityKey } from './storage/entityKeys.mjs';

export { configDocumentNameForPath, eventStreamNameForPath, requirePostgresStorageBackend } from './storage/contract.mjs';

export const POSTGRES_ADAPTER_STATUS = 'ready';

const GLOBAL_STORAGE_LOCK_ID = 1937018148;
const EVENT_STREAM_LOCK_NAMESPACE = 1937018149;
const CONFIG_LOCK_NAMESPACE = 1937018150;
const ROUTEBOOK_ENTITY_LOCK_NAMESPACE = 1937018151;
const ENTITY_MUTATION_LOCK_NAMESPACE = 1937018152;
const ROUTEBOOK_VERSION_UNIQUE_INDEX = 'event_rows_routebook_entity_version_uidx';
const INSERT_BATCH_SIZE = 500;
const ENTITY_KEY_BACKFILL_BATCH_SIZE = 1000;
const LATEST_UNIQUE_PAGE_SIZE = 200;
const ENTITY_MUTATION_SEMAPHORES = new WeakMap();

function entityMutationSemaphoreForPool(pool) {
  const existing = ENTITY_MUTATION_SEMAPHORES.get(pool);
  if (existing) return existing;
  const poolMax = Number.isSafeInteger(Number(pool?.options?.max)) ? Number(pool.options.max) : 10;
  const semaphore = {
    capacity: Math.max(1, poolMax - 1),
    active: 0,
    waiters: []
  };
  ENTITY_MUTATION_SEMAPHORES.set(pool, semaphore);
  return semaphore;
}

async function acquireEntityMutationSlot(semaphore) {
  if (semaphore.active < semaphore.capacity) {
    semaphore.active += 1;
  } else {
    await new Promise((resolveWaiter) => semaphore.waiters.push(resolveWaiter));
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = semaphore.waiters.shift();
    if (next) next();
    else semaphore.active = Math.max(0, semaphore.active - 1);
  };
}

export function describePostgresAdapter() {
  return {
    status: POSTGRES_ADAPTER_STATUS,
    storageBackend: 'postgres',
    ready: true,
    authority: 'trusted_routebook.event_rows',
    eventStreams: EVENT_STREAMS.length,
    configDocuments: CONFIG_DOCUMENTS.length,
    jsonlRole: 'migration-input-and-rollback-export-only'
  };
}

export function createPostgresAdapter(options = {}) {
  return new PostgresEventRowsAdapter(options);
}

export async function initializePostgresRuntime(options = {}) {
  requirePostgresStorageBackend(options.storageBackend ?? process.env.STORAGE_BACKEND);
  const adapter = createPostgresAdapter(options);
  try {
    await adapter.assertReady({ refresh: true });
    if (options.backfillEntityKeys !== false) {
      // Lookups are correct without it (NULL keys are evaluated in JS); the
      // backfill only restores index-backed performance for legacy rows.
      await adapter.backfillEntityKeys().catch((error) => {
        process.stderr.write(
          `${JSON.stringify({ level: 'warn', event: 'postgres_entity_key_backfill_skipped', code: typeof error?.code === 'string' ? error.code : 'BACKFILL_FAILED' })}\n`
        );
      });
    }
    return adapter;
  } catch (error) {
    await adapter.close().catch(() => {});
    throw error;
  }
}

export class PostgresEventRowsAdapter {
  /** @param {{pool?: any, profileIdSecret?: string, environment?: NodeJS.ProcessEnv} & Record<string, any>} [options] */
  constructor({ pool, profileIdSecret, environment = process.env, ...connectionOptions } = {}) {
    this.pool = pool ?? createPostgresPool({ environment, ...connectionOptions });
    this.ownsPool = !pool;
    this.entityMutationSemaphore = entityMutationSemaphoreForPool(this.pool);
    this.entityLockContext = new AsyncLocalStorage();
    this.readyVerified = false;
    this.profileSecretFingerprint = profileIdSecretFingerprint(profileIdSecret ?? environment.PROFILE_ID_SECRET);
  }

  async checkReadiness() {
    try {
      const catalog = await this.pool.query(`
        select
          to_regclass('${POSTGRES_SCHEMA}.schema_migrations') is not null as schema_migrations,
          to_regclass('${POSTGRES_SCHEMA}.event_rows') is not null as event_rows,
          to_regclass('${POSTGRES_SCHEMA}.config_documents') is not null as config_documents,
          to_regclass('${POSTGRES_SCHEMA}.storage_state') is not null as storage_state,
          to_regclass('${POSTGRES_SCHEMA}.event_rows_id_seq') is not null as event_rows_id_seq,
          exists (
            select 1
            from pg_catalog.pg_attribute
            where attrelid = to_regclass('${POSTGRES_SCHEMA}.event_rows')
              and attname = 'routebook_version_enforced'
              and not attisdropped
          ) as routebook_version_enforced_column,
          to_regclass('${POSTGRES_SCHEMA}.${ROUTEBOOK_VERSION_UNIQUE_INDEX}') is not null as routebook_version_index
      `);
      const tables = catalog.rows[0] ?? {};
      if (
        !tables.schema_migrations ||
        !tables.event_rows ||
        !tables.config_documents ||
        !tables.storage_state ||
        !tables.event_rows_id_seq ||
        !tables.routebook_version_enforced_column ||
        !tables.routebook_version_index
      ) {
        return {
          ready: false,
          code: 'POSTGRES_SCHEMA_NOT_MIGRATED',
          backend: 'postgres',
          schemaVersion: null
        };
      }
      const privileges = await this.pool.query(`
        select
          has_schema_privilege(current_user, '${POSTGRES_SCHEMA}', 'USAGE') as schema_usage,
          has_table_privilege(current_user, '${POSTGRES_SCHEMA}.event_rows', 'SELECT') and
            has_table_privilege(current_user, '${POSTGRES_SCHEMA}.event_rows', 'INSERT') and
            has_table_privilege(current_user, '${POSTGRES_SCHEMA}.event_rows', 'DELETE') as event_rows,
          has_table_privilege(current_user, '${POSTGRES_SCHEMA}.config_documents', 'SELECT') and
            has_table_privilege(current_user, '${POSTGRES_SCHEMA}.config_documents', 'INSERT') and
            has_table_privilege(current_user, '${POSTGRES_SCHEMA}.config_documents', 'UPDATE') as config_documents,
          has_table_privilege(current_user, '${POSTGRES_SCHEMA}.storage_state', 'SELECT') as storage_state,
          has_sequence_privilege(current_user, '${POSTGRES_SCHEMA}.event_rows_id_seq', 'USAGE') as event_rows_sequence
      `);
      if (Object.values(privileges.rows[0] ?? {}).some((allowed) => allowed !== true)) {
        return {
          ready: false,
          code: 'POSTGRES_PRIVILEGES_MISSING',
          backend: 'postgres',
          schemaVersion: null
        };
      }
      const stateResult = await this.pool.query(`
        select
          schema_version,
          phase,
          cutover_ready,
          profile_secret_fingerprint,
          source_manifest_sha256,
          backfilled_at,
          parity_checked_at
        from ${POSTGRES_SCHEMA}.storage_state
        where singleton_id = 1
      `);
      if (stateResult.rowCount !== 1) {
        return {
          ready: false,
          code: 'POSTGRES_STORAGE_STATE_MISSING',
          backend: 'postgres',
          schemaVersion: null
        };
      }
      const state = stateResult.rows[0];
      const schemaVersion = Number(state.schema_version);
      if (schemaVersion !== POSTGRES_STORAGE_SCHEMA_VERSION) {
        return {
          ready: false,
          code: 'POSTGRES_SCHEMA_VERSION_MISMATCH',
          backend: 'postgres',
          schemaVersion,
          expectedSchemaVersion: POSTGRES_STORAGE_SCHEMA_VERSION,
          phase: state.phase
        };
      }
      if (state.profile_secret_fingerprint && !this.profileSecretFingerprint) {
        return {
          ready: false,
          code: 'POSTGRES_PROFILE_SECRET_REQUIRED',
          backend: 'postgres',
          schemaVersion,
          phase: state.phase
        };
      }
      if (state.profile_secret_fingerprint && state.profile_secret_fingerprint !== this.profileSecretFingerprint) {
        return {
          ready: false,
          code: 'POSTGRES_PROFILE_SECRET_MISMATCH',
          backend: 'postgres',
          schemaVersion,
          phase: state.phase
        };
      }
      if (!state.cutover_ready || state.phase !== 'ready') {
        return {
          ready: false,
          code: 'POSTGRES_CUTOVER_NOT_READY',
          backend: 'postgres',
          schemaVersion,
          phase: state.phase,
          sourceManifestSha256: state.source_manifest_sha256 ?? null
        };
      }
      if (!state.profile_secret_fingerprint) {
        return {
          ready: false,
          code: 'POSTGRES_PROFILE_SECRET_UNINITIALIZED',
          backend: 'postgres',
          schemaVersion,
          phase: state.phase
        };
      }
      return {
        ready: true,
        code: 'READY',
        backend: 'postgres',
        schemaVersion,
        phase: state.phase,
        sourceManifestSha256: state.source_manifest_sha256,
        backfilledAt: dateToIso(state.backfilled_at),
        parityCheckedAt: dateToIso(state.parity_checked_at)
      };
    } catch (error) {
      return {
        ready: false,
        code: readinessFailureCode(error),
        backend: 'postgres',
        postgresCode: typeof error?.code === 'string' ? error.code : null
      };
    }
  }

  async assertReady({ refresh = false } = {}) {
    if (this.readyVerified && !refresh) return true;
    const readiness = await this.checkReadiness();
    if (!readiness.ready) {
      const error = storageContractError(readiness.code, `PostgreSQL storage is not ready: ${readiness.code}`);
      error.readiness = readiness;
      throw error;
    }
    this.readyVerified = true;
    return true;
  }

  async appendJsonLine(streamName, payload) {
    const stream = assertEventStreamName(streamName);
    const normalized = normalizeJsonObject(payload, `${stream} event row`);
    const payloadSha256 = jsonSha256(normalized);
    await this.assertReady();
    return withPostgresTransaction(this.pool, async (client) => {
      await lockRuntimeMutation(client);
      await assertRuntimeStorageReady(client, this.profileSecretFingerprint);
      await lockEventStream(client, stream);
      const result = await client.query(
        `
        insert into ${POSTGRES_SCHEMA}.event_rows (stream, ordinal, payload, payload_sha256, entity_key)
        select $1, coalesce(max(ordinal), 0) + 1, $2::jsonb, $3, $4
        from ${POSTGRES_SCHEMA}.event_rows
        where stream = $1
        returning ordinal, inserted_at
      `,
        [stream, JSON.stringify(normalized), payloadSha256, storedEntityKey(stream, normalized)]
      );
      return {
        stream,
        ordinal: Number(result.rows[0].ordinal),
        insertedAt: dateToIso(result.rows[0].inserted_at),
        payload: normalized
      };
    });
  }

  async appendVersionedRoutebook(payload, { expectedVersion = undefined } = {}) {
    const normalized = normalizeJsonObject(payload, 'routebooks versioned event row');
    const routebookId = routebookIdFromPayload(normalized);
    const expected = nonNegativeSafeInteger(expectedVersion, 'ROUTEBOOK_EXPECTED_VERSION_INVALID', 'expectedVersion must be a non-negative safe integer');
    const nextVersion = expected + 1;
    if (!Number.isSafeInteger(nextVersion)) {
      throw storageContractError('ROUTEBOOK_VERSION_OVERFLOW', 'The next routebook version exceeds the safe integer range');
    }
    if (normalized.version !== nextVersion) {
      throw storageContractError('ROUTEBOOK_VERSION_INVALID', `Routebook payload version must equal expectedVersion + 1 (${nextVersion})`);
    }
    const expectedParentVersion = expected || null;
    if ((normalized.parentVersion ?? null) !== expectedParentVersion) {
      throw storageContractError('ROUTEBOOK_PARENT_VERSION_INVALID', `Routebook parentVersion must equal ${expectedParentVersion ?? 'null'}`);
    }
    const payloadSha256 = jsonSha256(normalized);
    await this.assertReady();
    return withPostgresTransaction(this.pool, async (client) => {
      await lockRuntimeMutation(client);
      await assertRuntimeStorageReady(client, this.profileSecretFingerprint);
      await lockRoutebookEntity(client, routebookId);
      let currentVersion = await readCurrentRoutebookVersion(client, routebookId);
      if (currentVersion !== expected) throw routebookVersionConflict(currentVersion);

      await lockEventStream(client, 'routebooks');
      await client.query('savepoint append_versioned_routebook');
      let result;
      try {
        result = await client.query(
          `
          insert into ${POSTGRES_SCHEMA}.event_rows (stream, ordinal, payload, payload_sha256, entity_key)
          select 'routebooks', coalesce(max(ordinal), 0) + 1, $1::jsonb, $2, $3
          from ${POSTGRES_SCHEMA}.event_rows
          where stream = 'routebooks'
          returning ordinal, inserted_at
        `,
          [JSON.stringify(normalized), payloadSha256, storedEntityKey('routebooks', normalized)]
        );
        await client.query('release savepoint append_versioned_routebook');
      } catch (error) {
        if (error?.code !== '23505' || error?.constraint !== ROUTEBOOK_VERSION_UNIQUE_INDEX) throw error;
        await client.query('rollback to savepoint append_versioned_routebook');
        currentVersion = await readCurrentRoutebookVersion(client, routebookId);
        throw routebookVersionConflict(currentVersion);
      }
      return {
        stream: 'routebooks',
        ordinal: Number(result.rows[0].ordinal),
        insertedAt: dateToIso(result.rows[0].inserted_at),
        currentVersion: nextVersion,
        payload: normalized
      };
    });
  }

  async withEntityMutationLock(namespace, entityId, operation) {
    assertPredicate(operation, 'operation');
    const lockKey = entityMutationLockKey(namespace, entityId);
    const nestedClient = this.entityLockContext.getStore();
    if (nestedClient) {
      await nestedClient.query('select pg_advisory_lock($1::integer, hashtext($2))', [ENTITY_MUTATION_LOCK_NAMESPACE, lockKey]);
      try {
        return await operation();
      } finally {
        await nestedClient.query('select pg_advisory_unlock($1::integer, hashtext($2))', [ENTITY_MUTATION_LOCK_NAMESPACE, lockKey]);
      }
    }
    if (Number(this.pool?.options?.max) === 1) {
      throw storageContractError('POSTGRES_ENTITY_LOCK_POOL_TOO_SMALL', 'Entity mutation locks require a PostgreSQL pool with at least two connections');
    }
    await this.assertReady();
    const releaseSlot = await acquireEntityMutationSlot(this.entityMutationSemaphore);
    let client = null;
    let locked = false;
    let primaryError = null;
    let unlockError = null;
    let result;
    try {
      client = await this.pool.connect();
      await client.query('select pg_advisory_lock($1::integer, hashtext($2))', [ENTITY_MUTATION_LOCK_NAMESPACE, lockKey]);
      locked = true;
      result = await this.entityLockContext.run(client, operation);
    } catch (error) {
      primaryError = error;
    } finally {
      if (locked) {
        try {
          const unlocked = await client.query('select pg_advisory_unlock($1::integer, hashtext($2)) as unlocked', [ENTITY_MUTATION_LOCK_NAMESPACE, lockKey]);
          if (unlocked.rows[0]?.unlocked !== true) {
            unlockError = storageContractError('POSTGRES_ENTITY_LOCK_RELEASE_FAILED', 'PostgreSQL did not release the entity mutation lock');
          }
        } catch (error) {
          unlockError = error;
        }
      }
      try {
        client?.release(unlockError ?? undefined);
      } finally {
        releaseSlot();
      }
    }
    if (primaryError) throw primaryError;
    if (unlockError) throw unlockError;
    return result;
  }

  async readJsonLines(streamName, limit = 50) {
    const stream = assertEventStreamName(streamName);
    const readAll = Number(limit) === Number.POSITIVE_INFINITY;
    const safeLimit = readAll ? undefined : boundedPositiveInteger(limit, 50, 1_000_000);
    await this.assertReady();
    return withRuntimeStorageRead(this.pool, this.profileSecretFingerprint, (client) =>
      this.#readEventRows(client, stream, { order: 'newest', limit: safeLimit })
    );
  }

  async findLatestJsonLine(streamName, predicate, scanLimit = 50000) {
    const stream = assertEventStreamName(streamName);
    assertPredicate(predicate);
    // Predicates are arbitrary JavaScript, so a fixed SQL tail window could hide
    // an older entity in a busy shared stream. Scan the authoritative stream.
    void scanLimit;
    await this.assertReady();
    const rows = await withRuntimeStorageRead(this.pool, this.profileSecretFingerprint, (client) => this.#readEventRows(client, stream, { order: 'newest' }));
    return rows.find(predicate) ?? null;
  }

  async readLatestUniqueJsonLines(streamName, keyFn, limit = 100, scanLimit = 50000, predicate = null) {
    const stream = assertEventStreamName(streamName);
    assertPredicate(keyFn, 'keyFn');
    const safeLimit = boundedPositiveInteger(limit, 100, 1_000_000);
    void scanLimit;
    await this.assertReady();
    if (keyFn === entityKeyFunctionForStream(stream)) {
      const keyed = await this.#readLatestUniqueByEntityKey(stream, safeLimit, predicate);
      if (keyed) return keyed;
    }
    const rows = await withRuntimeStorageRead(this.pool, this.profileSecretFingerprint, (client) => this.#readEventRows(client, stream, { order: 'newest' }));
    const latestByKey = new Map();
    const seen = new Set();
    for (const row of rows) {
      const key = keyFn(row);
      if (key && !seen.has(key)) {
        seen.add(key);
        if (!predicate || predicate(row)) latestByKey.set(key, row);
      }
      if (latestByKey.size >= safeLimit) break;
    }
    return [...latestByKey.values()];
  }

  /**
   * Latest row whose stream entity key (entityKeys.mjs) equals `key`.
   * Index probe + LIMIT 1, plus any rows whose key is not computed yet.
   */
  async findLatestByEntityKey(streamName, key) {
    const stream = assertEventStreamName(streamName);
    const keyFn = entityKeyFunctionForStream(stream);
    if (!keyFn) throw storageContractError('ENTITY_KEY_UNSUPPORTED', `Stream ${stream} has no entity key`);
    const rawKey = String(key ?? '');
    if (!rawKey) return null;
    await this.assertReady();
    return withRuntimeStorageRead(this.pool, this.profileSecretFingerprint, async (client) => {
      const result = await client.query(
        `
        (select ordinal, payload, payload_sha256
          from ${POSTGRES_SCHEMA}.event_rows
          where stream = $1 and entity_key = $2
          order by ordinal desc
          limit 1)
        union all
        (select ordinal, payload, payload_sha256
          from ${POSTGRES_SCHEMA}.event_rows
          where stream = $1 and entity_key is null)
      `,
        [stream, encodeEntityKey(rawKey)]
      );
      let best = null;
      for (const row of result.rows) {
        const payload = verifyStoredObject(row.payload, row.payload_sha256, `${stream} event row ${row.ordinal}`);
        if (keyFn(payload) !== rawKey) continue;
        const ordinal = Number(row.ordinal);
        if (!best || ordinal > best.ordinal) best = { ordinal, payload };
      }
      return best?.payload ?? null;
    });
  }

  /** Latest row in `stream` whose secondary `field` equals `value` (expression index). */
  async findLatestBySecondaryKey(streamName, field, value) {
    const stream = assertEventStreamName(streamName);
    const keyFn = secondaryKeyFunction(stream, field);
    if (!keyFn) throw storageContractError('SECONDARY_KEY_UNSUPPORTED', `Stream ${stream} has no secondary key ${field}`);
    const expected = String(value ?? '');
    if (!expected) return null;
    await this.assertReady();
    return withRuntimeStorageRead(this.pool, this.profileSecretFingerprint, async (client) => {
      // field is whitelisted by secondaryKeyFunction; the literal is quoted.
      const result = await client.query(
        `
        select ordinal, payload, payload_sha256
        from ${POSTGRES_SCHEMA}.event_rows
        where stream = $1 and payload->>'${field.replace(/'/g, "''")}' = $2
        order by ordinal desc
        limit 1
      `,
        [stream, expected]
      );
      const row = result.rows[0];
      if (!row) return null;
      const payload = verifyStoredObject(row.payload, row.payload_sha256, `${stream} event row ${row.ordinal}`);
      return keyFn(payload) === expected ? payload : null;
    });
  }

  /**
   * Computes entity_key for rows written before migration 0006 (or by an older
   * binary). Idempotent and safe to run concurrently; requires UPDATE on
   * event_rows (column-level `update (entity_key)` is enough).
   */
  async backfillEntityKeys({ batchSize = ENTITY_KEY_BACKFILL_BATCH_SIZE } = {}) {
    await this.assertReady();
    const size = boundedPositiveInteger(batchSize, ENTITY_KEY_BACKFILL_BATCH_SIZE, 10_000);
    let updated = 0;
    let afterId = 0;
    for (;;) {
      const pending = await this.pool.query(
        `
        select id, stream, payload
        from ${POSTGRES_SCHEMA}.event_rows
        where entity_key is null and id > $1
        order by id
        limit $2
      `,
        [afterId, size]
      );
      if (!pending.rowCount) break;
      const assignments = pending.rows.map((row) => ({ id: String(row.id), entity_key: storedEntityKey(row.stream, row.payload) }));
      const result = await this.pool.query(
        `
        update ${POSTGRES_SCHEMA}.event_rows as event_row
        set entity_key = assignment.entity_key
        from jsonb_to_recordset($1::jsonb) as assignment (id bigint, entity_key text)
        where event_row.id = assignment.id and event_row.entity_key is null
      `,
        [JSON.stringify(assignments)]
      );
      updated += result.rowCount;
      afterId = Number(pending.rows[pending.rows.length - 1].id);
      if (pending.rowCount < size) break;
    }
    return { updated };
  }

  async streamFingerprint(streamName) {
    const stream = assertEventStreamName(streamName);
    await this.assertReady();
    return withRuntimeStorageRead(this.pool, this.profileSecretFingerprint, async (client) => {
      const result = await client.query(
        `select count(*)::text as count, coalesce(max(id), 0)::text as last_id from ${POSTGRES_SCHEMA}.event_rows where stream = $1`,
        [stream]
      );
      return `${result.rows[0].count}:${result.rows[0].last_id}`;
    });
  }

  async readMatchingJsonLines(streamName, predicate, limit = 50, scanLimit = 50000) {
    const stream = assertEventStreamName(streamName);
    assertPredicate(predicate);
    const safeLimit = boundedPositiveInteger(limit, 50, 1_000_000);
    void scanLimit;
    await this.assertReady();
    const rows = await withRuntimeStorageRead(this.pool, this.profileSecretFingerprint, (client) => this.#readEventRows(client, stream, { order: 'newest' }));
    const output = [];
    for (const row of rows) {
      if (predicate(row)) output.push(row);
      if (output.length >= safeLimit) break;
    }
    return output;
  }

  async rewriteJsonlExcluding(streamName, predicate) {
    const stream = assertEventStreamName(streamName);
    assertPredicate(predicate);
    await this.assertReady();
    return withPostgresTransaction(this.pool, async (client) => {
      await lockRuntimeMutation(client);
      await assertRuntimeStorageReady(client, this.profileSecretFingerprint);
      await lockEventStream(client, stream);
      const rows = await this.#readEventRows(client, stream, { order: 'oldest' });
      const retained = [];
      let removed = 0;
      for (const row of rows) {
        if (predicate(row)) removed += 1;
        else retained.push(row);
      }
      if (!removed) return 0;
      await client.query(`delete from ${POSTGRES_SCHEMA}.event_rows where stream = $1`, [stream]);
      await insertEventRows(client, stream, retained);
      return removed;
    });
  }

  async rewriteJsonlRows(streamName, transform) {
    const stream = assertEventStreamName(streamName);
    assertPredicate(transform, 'transform');
    await this.assertReady();
    return withPostgresTransaction(this.pool, async (client) => {
      await lockRuntimeMutation(client);
      await assertRuntimeStorageReady(client, this.profileSecretFingerprint);
      await lockEventStream(client, stream);
      const rows = await this.#readEventRows(client, stream, { order: 'oldest' });
      const rewritten = [];
      let changed = 0;
      for (let index = 0; index < rows.length; index += 1) {
        const current = rows[index];
        const next = normalizeJsonObject(transform(current), `${stream} transformed event row ${index + 1}`);
        rewritten.push(next);
        if (jsonSha256(next) !== jsonSha256(current)) changed += 1;
      }
      if (!changed) return 0;
      await client.query(`delete from ${POSTGRES_SCHEMA}.event_rows where stream = $1`, [stream]);
      await insertEventRows(client, stream, rewritten);
      return changed;
    });
  }

  async readConfigDocument(configName) {
    const name = assertConfigDocumentName(configName);
    await this.assertReady();
    const result = await withRuntimeStorageRead(this.pool, this.profileSecretFingerprint, (client) =>
      client.query(
        `
        select document, document_sha256, revision, updated_at
        from ${POSTGRES_SCHEMA}.config_documents
        where name = $1
      `,
        [name]
      )
    );
    if (!result.rowCount) return null;
    const row = result.rows[0];
    const document = verifyStoredObject(row.document, row.document_sha256, `${name} config document`);
    return {
      name,
      document,
      revision: Number(row.revision),
      updatedAt: dateToIso(row.updated_at)
    };
  }

  async writeConfigDocument(configName, document) {
    const name = assertConfigDocumentName(configName);
    const normalized = normalizeJsonObject(document, `${name} config document`);
    const documentSha256 = jsonSha256(normalized);
    await this.assertReady();
    return withPostgresTransaction(this.pool, async (client) => {
      await lockRuntimeMutation(client);
      await assertRuntimeStorageReady(client, this.profileSecretFingerprint);
      await lockConfigDocument(client, name);
      const result = await client.query(
        `
        insert into ${POSTGRES_SCHEMA}.config_documents (
          name, document, document_sha256, revision, updated_at
        ) values ($1, $2::jsonb, $3, 1, clock_timestamp())
        on conflict (name) do update set
          document = excluded.document,
          document_sha256 = excluded.document_sha256,
          revision = ${POSTGRES_SCHEMA}.config_documents.revision + 1,
          updated_at = clock_timestamp()
        returning revision, updated_at
      `,
        [name, JSON.stringify(normalized), documentSha256]
      );
      return {
        name,
        document: normalized,
        revision: Number(result.rows[0].revision),
        updatedAt: dateToIso(result.rows[0].updated_at)
      };
    });
  }

  async loadStorageSnapshot({ allowNotReady = false } = {}) {
    if (!allowNotReady) await this.assertReady();
    const client = await this.pool.connect();
    try {
      await client.query('begin transaction isolation level repeatable read read only');
      await lockRuntimeMutation(client);
      if (!allowNotReady) await assertRuntimeStorageReady(client, this.profileSecretFingerprint);
      const snapshot = await this.#loadStorageSnapshotFrom(client);
      await client.query('commit');
      return snapshot;
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async replaceWithFilesystemSnapshot(snapshot, { force = false } = {}) {
    assertStorageSnapshot(snapshot);
    const result = await withPostgresTransaction(this.pool, async (client) => {
      await lockExclusiveStorage(client);
      const stateResult = await client.query(`
        select phase, cutover_ready
        from ${POSTGRES_SCHEMA}.storage_state
        where singleton_id = 1
        for update
      `);
      if (stateResult.rowCount !== 1) {
        throw storageContractError('POSTGRES_STORAGE_STATE_MISSING', 'PostgreSQL storage_state row is missing');
      }
      if (stateResult.rows[0].cutover_ready) {
        throw storageContractError(
          'POSTGRES_ONLINE_BACKFILL_FORBIDDEN',
          'PostgreSQL is already cut over. Online destructive backfill is forbidden; stop runtime traffic and use a fresh restore target.'
        );
      }
      if (stateResult.rows[0].phase !== 'empty' && !force) {
        throw storageContractError(
          'POSTGRES_BACKFILL_OVERWRITE_REQUIRES_FORCE',
          'PostgreSQL already contains a non-ready backfill. Use --force only after confirming runtime traffic is stopped.'
        );
      }
      if (!this.profileSecretFingerprint) {
        throw storageContractError('POSTGRES_PROFILE_SECRET_REQUIRED', 'A non-empty PROFILE_ID_SECRET is required before PostgreSQL backfill.');
      }

      await client.query(`delete from ${POSTGRES_SCHEMA}.event_rows`);
      await client.query(`delete from ${POSTGRES_SCHEMA}.config_documents`);
      for (const definition of EVENT_STREAMS) {
        await insertEventRows(client, definition.name, snapshot.streams[definition.name].rows);
      }
      for (const definition of CONFIG_DOCUMENTS) {
        const entry = snapshot.configs[definition.name];
        if (!entry.present) continue;
        await client.query(
          `
          insert into ${POSTGRES_SCHEMA}.config_documents (
            name, document, document_sha256, revision, updated_at
          ) values ($1, $2::jsonb, $3, 1, clock_timestamp())
        `,
          [definition.name, JSON.stringify(entry.document), entry.sha256]
        );
      }
      const state = await client.query(
        `
        update ${POSTGRES_SCHEMA}.storage_state
        set
          schema_version = $1,
          phase = 'backfilled',
          cutover_ready = false,
          profile_secret_fingerprint = $4,
          source_manifest_sha256 = $2,
          source_manifest = $3::jsonb,
          parity_report = null,
          backfilled_at = clock_timestamp(),
          parity_checked_at = null,
          updated_at = clock_timestamp()
        where singleton_id = 1
        returning backfilled_at
      `,
        [POSTGRES_STORAGE_SCHEMA_VERSION, snapshot.manifestSha256, JSON.stringify(snapshot.manifest), this.profileSecretFingerprint]
      );
      return {
        manifestSha256: snapshot.manifestSha256,
        rows: EVENT_STREAMS.reduce((sum, definition) => sum + snapshot.streams[definition.name].count, 0),
        configs: CONFIG_DOCUMENTS.filter(({ name }) => snapshot.configs[name].present).length,
        backfilledAt: dateToIso(state.rows[0].backfilled_at)
      };
    });
    this.readyVerified = false;
    return result;
  }

  async compareFilesystemSnapshot(snapshot, { markReady = false } = {}) {
    assertStorageSnapshot(snapshot);
    return withPostgresTransaction(this.pool, async (client) => {
      await lockExclusiveStorage(client);
      const stateResult = await client.query(`
        select phase, cutover_ready, source_manifest_sha256, profile_secret_fingerprint
        from ${POSTGRES_SCHEMA}.storage_state
        where singleton_id = 1
        for update
      `);
      if (stateResult.rowCount !== 1) {
        throw storageContractError('POSTGRES_STORAGE_STATE_MISSING', 'PostgreSQL storage_state row is missing');
      }
      const state = stateResult.rows[0];
      if (!this.profileSecretFingerprint) {
        throw storageContractError('POSTGRES_PROFILE_SECRET_REQUIRED', 'A non-empty PROFILE_ID_SECRET is required before PostgreSQL parity.');
      }
      if (state.profile_secret_fingerprint && state.profile_secret_fingerprint !== this.profileSecretFingerprint) {
        throw storageContractError('POSTGRES_PROFILE_SECRET_MISMATCH', 'PROFILE_ID_SECRET does not match the secret used for PostgreSQL backfill.');
      }
      const databaseSnapshot = await this.#loadStorageSnapshotFrom(client);
      const comparison = compareStorageSnapshots(snapshot, databaseSnapshot);
      if (state.source_manifest_sha256 !== snapshot.manifestSha256) {
        comparison.matches = false;
        comparison.differences.unshift({
          kind: 'migration-manifest',
          expectedSha256: state.source_manifest_sha256,
          actualSha256: snapshot.manifestSha256
        });
      }
      if (markReady && !comparison.matches) {
        const error = storageContractError('POSTGRES_PARITY_MISMATCH', 'PostgreSQL parity failed; cutover-ready was not changed.');
        error.comparison = comparison;
        throw error;
      }
      if (markReady) {
        if (state.phase !== 'backfilled' && !state.cutover_ready) {
          throw storageContractError('POSTGRES_BACKFILL_REQUIRED', 'PostgreSQL backfill must complete before cutover.');
        }
        const parityReport = {
          matches: true,
          expectedManifestSha256: comparison.expectedManifestSha256,
          actualManifestSha256: comparison.actualManifestSha256,
          differences: []
        };
        const updated = await client.query(
          `
          update ${POSTGRES_SCHEMA}.storage_state
          set
            phase = 'ready',
            cutover_ready = true,
            profile_secret_fingerprint = $2,
            parity_report = $1::jsonb,
            parity_checked_at = clock_timestamp(),
            updated_at = clock_timestamp()
          where singleton_id = 1
          returning parity_checked_at
        `,
          [JSON.stringify(parityReport), this.profileSecretFingerprint]
        );
        this.readyVerified = true;
        comparison.markedReady = true;
        comparison.parityCheckedAt = dateToIso(updated.rows[0].parity_checked_at);
      } else {
        comparison.markedReady = false;
      }
      return comparison;
    });
  }

  async close() {
    if (this.ownsPool) await this.pool.end();
  }

  /**
   * Latest row per entity key, newest first, filtered by `predicate` on that
   * latest row (same semantics as the JSONL reverse scan: a key is "seen" at
   * its newest row even when the predicate rejects it). Returns null when the
   * stream still has rows without a computed key, so the caller falls back to
   * the exact full scan.
   */
  async #readLatestUniqueByEntityKey(stream, limit, predicate) {
    return withRuntimeStorageRead(this.pool, this.profileSecretFingerprint, async (client) => {
      const pending = await client.query(`select 1 from ${POSTGRES_SCHEMA}.event_rows where stream = $1 and entity_key is null limit 1`, [stream]);
      if (pending.rowCount) return null;
      const output = [];
      let beforeOrdinal = null;
      for (;;) {
        const page = await client.query(
          `
          select latest.ordinal, latest.payload, latest.payload_sha256
          from ${POSTGRES_SCHEMA}.event_rows as latest
          where latest.stream = $1
            and latest.entity_key is not null
            and latest.entity_key <> ''
            and ($2::bigint is null or latest.ordinal < $2::bigint)
            and not exists (
              select 1
              from ${POSTGRES_SCHEMA}.event_rows as newer
              where newer.stream = latest.stream
                and newer.entity_key = latest.entity_key
                and newer.ordinal > latest.ordinal
            )
          order by latest.ordinal desc
          limit $3
        `,
          [stream, beforeOrdinal, LATEST_UNIQUE_PAGE_SIZE]
        );
        for (const row of page.rows) {
          const payload = verifyStoredObject(row.payload, row.payload_sha256, `${stream} event row ${row.ordinal}`);
          if (!predicate || predicate(payload)) output.push(payload);
          if (output.length >= limit) return output;
        }
        if (page.rowCount < LATEST_UNIQUE_PAGE_SIZE) return output;
        beforeOrdinal = page.rows[page.rows.length - 1].ordinal;
      }
    });
  }

  async #readEventRows(queryable, stream, { order = 'newest', limit = undefined } = {}) {
    const direction = order === 'oldest' ? 'asc' : 'desc';
    const parameters = [stream];
    const limitSql = limit === undefined ? '' : 'limit $2';
    if (limit !== undefined) parameters.push(limit);
    const result = await queryable.query(
      `
      select ordinal, payload, payload_sha256
      from ${POSTGRES_SCHEMA}.event_rows
      where stream = $1
      order by ordinal ${direction}
      ${limitSql}
    `,
      parameters
    );
    return result.rows.map((row) => verifyStoredObject(row.payload, row.payload_sha256, `${stream} event row ${row.ordinal}`));
  }

  async #loadStorageSnapshotFrom(queryable) {
    const streams = {};
    const configs = {};
    for (const definition of EVENT_STREAMS) {
      streams[definition.name] = {
        present: true,
        rows: await this.#readEventRows(queryable, definition.name, { order: 'oldest' })
      };
    }
    const configRows = await queryable.query(`
      select name, document, document_sha256
      from ${POSTGRES_SCHEMA}.config_documents
      order by name
    `);
    const configByName = new Map(configRows.rows.map((row) => [row.name, row]));
    for (const definition of CONFIG_DOCUMENTS) {
      const row = configByName.get(definition.name);
      configs[definition.name] = row
        ? {
            present: true,
            document: verifyStoredObject(row.document, row.document_sha256, `${definition.name} config document`)
          }
        : { present: false };
    }
    return buildStorageSnapshot({ streams, configs, source: 'postgres' });
  }
}

async function insertEventRows(client, streamName, rows) {
  const stream = assertEventStreamName(streamName);
  const versionKeys = stream === 'routebooks' ? rows.map(routebookVersionEnforcementKey) : [];
  const lastOrdinalByVersionKey = new Map();
  versionKeys.forEach((key, index) => {
    if (key) lastOrdinalByVersionKey.set(key, index + 1);
  });
  for (let offset = 0; offset < rows.length; offset += INSERT_BATCH_SIZE) {
    const batch = rows.slice(offset, offset + INSERT_BATCH_SIZE).map((payload, index) => {
      const ordinal = offset + index + 1;
      const normalized = normalizeJsonObject(payload, `${stream} event row ${ordinal}`);
      const versionKey = versionKeys[ordinal - 1];
      return {
        ordinal,
        payload: normalized,
        payload_sha256: jsonSha256(normalized),
        routebook_version_enforced: !versionKey || lastOrdinalByVersionKey.get(versionKey) === ordinal,
        entity_key: storedEntityKey(stream, normalized)
      };
    });
    await client.query(
      `
      insert into ${POSTGRES_SCHEMA}.event_rows (
        stream,
        ordinal,
        payload,
        payload_sha256,
        routebook_version_enforced,
        entity_key
      )
      select $1, rows.ordinal, rows.payload, rows.payload_sha256, rows.routebook_version_enforced, rows.entity_key
      from jsonb_to_recordset($2::jsonb) as rows (
        ordinal bigint,
        payload jsonb,
        payload_sha256 text,
        routebook_version_enforced boolean,
        entity_key text
      )
      order by rows.ordinal
    `,
      [stream, JSON.stringify(batch)]
    );
  }
}

async function withRuntimeStorageRead(pool, profileSecretFingerprint, operation) {
  const client = await pool.connect();
  try {
    await client.query('begin transaction isolation level repeatable read read only');
    await lockRuntimeMutation(client);
    await assertRuntimeStorageReady(client, profileSecretFingerprint);
    const result = await operation(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function assertRuntimeStorageReady(queryable, profileSecretFingerprint) {
  const result = await queryable.query(`
    select schema_version, phase, cutover_ready, profile_secret_fingerprint
    from ${POSTGRES_SCHEMA}.storage_state
    where singleton_id = 1
  `);
  const state = result.rows[0];
  if (!state) {
    throw storageContractError('POSTGRES_STORAGE_STATE_MISSING', 'PostgreSQL storage_state row is missing');
  }
  if (Number(state.schema_version) !== POSTGRES_STORAGE_SCHEMA_VERSION) {
    throw storageContractError(
      'POSTGRES_SCHEMA_VERSION_MISMATCH',
      `PostgreSQL schema version is ${state.schema_version}; expected ${POSTGRES_STORAGE_SCHEMA_VERSION}`
    );
  }
  if (!profileSecretFingerprint) {
    throw storageContractError('POSTGRES_PROFILE_SECRET_REQUIRED', 'PROFILE_ID_SECRET is required for PostgreSQL runtime access');
  }
  if (state.profile_secret_fingerprint !== profileSecretFingerprint) {
    throw storageContractError(
      state.profile_secret_fingerprint ? 'POSTGRES_PROFILE_SECRET_MISMATCH' : 'POSTGRES_PROFILE_SECRET_UNINITIALIZED',
      'PostgreSQL profile secret fingerprint is missing or does not match this runtime'
    );
  }
  if (!state.cutover_ready || state.phase !== 'ready') {
    throw storageContractError('POSTGRES_CUTOVER_NOT_READY', 'PostgreSQL cutover readiness was revoked');
  }
}

async function lockRuntimeMutation(client) {
  await client.query('select pg_advisory_xact_lock_shared($1::bigint)', [GLOBAL_STORAGE_LOCK_ID]);
}

async function lockExclusiveStorage(client) {
  await client.query('select pg_advisory_xact_lock($1::bigint)', [GLOBAL_STORAGE_LOCK_ID]);
}

async function lockEventStream(client, stream) {
  await client.query('select pg_advisory_xact_lock($1::integer, hashtext($2))', [EVENT_STREAM_LOCK_NAMESPACE, stream]);
}

async function lockConfigDocument(client, name) {
  await client.query('select pg_advisory_xact_lock($1::integer, hashtext($2))', [CONFIG_LOCK_NAMESPACE, name]);
}

async function lockRoutebookEntity(client, routebookId) {
  await client.query('select pg_advisory_xact_lock($1::integer, hashtext($2))', [ROUTEBOOK_ENTITY_LOCK_NAMESPACE, routebookId]);
}

async function readCurrentRoutebookVersion(client, routebookId) {
  const result = await client.query(
    `
    select ordinal, payload, payload_sha256
    from ${POSTGRES_SCHEMA}.event_rows
    where stream = 'routebooks'
      and coalesce(payload->>'publicId', payload->>'id') = $1
    order by ordinal
  `,
    [routebookId]
  );
  let currentVersion = 0;
  for (const row of result.rows) {
    const payload = verifyStoredObject(row.payload, row.payload_sha256, `routebooks event row ${row.ordinal}`);
    const explicitVersion = positiveSafeInteger(payload.version);
    currentVersion = Math.max(currentVersion, explicitVersion ?? currentVersion + 1);
  }
  return currentVersion;
}

function routebookIdFromPayload(payload) {
  const publicId = payload.publicId == null ? '' : String(payload.publicId);
  const id = payload.id == null ? '' : String(payload.id);
  const selected = payload.publicId == null ? id : publicId;
  if (!selected || selected !== selected.trim()) {
    throw storageContractError('ROUTEBOOK_ID_INVALID', 'A non-empty, whitespace-normalized routebook publicId or id is required');
  }
  if (publicId && id && publicId !== id) {
    throw storageContractError('ROUTEBOOK_ID_MISMATCH', 'Routebook publicId and id must match');
  }
  return selected;
}

function routebookVersionEnforcementKey(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
  const rawId = payload.publicId == null ? payload.id : payload.publicId;
  const routebookId = rawId == null ? '' : String(rawId);
  if (!routebookId.trim()) return '';
  if (typeof payload.version !== 'number' || !Number.isFinite(payload.version)) return '';
  if (!Number.isInteger(payload.version) || payload.version <= 0) return '';
  return `${routebookId.length}:${routebookId}:${payload.version}`;
}

function routebookVersionConflict(currentVersion) {
  const error = storageContractError('ROUTEBOOK_VERSION_CONFLICT', `Routebook version conflict; current version is ${currentVersion}`);
  error.currentVersion = currentVersion;
  return error;
}

function entityMutationLockKey(namespace, entityId) {
  const normalizedNamespace = String(namespace ?? '').trim();
  const normalizedEntityId = String(entityId ?? '').trim();
  if (!normalizedNamespace || !normalizedEntityId) {
    throw storageContractError('POSTGRES_ENTITY_LOCK_KEY_INVALID', 'Entity mutation lock namespace and entityId must both be non-empty');
  }
  return `${normalizedNamespace.length}:${normalizedNamespace}:${normalizedEntityId}`;
}

function nonNegativeSafeInteger(value, code, message) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw storageContractError(code, message);
  return parsed;
}

function positiveSafeInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function verifyStoredObject(value, expectedSha256, label) {
  const normalized = normalizeJsonObject(typeof value === 'string' ? JSON.parse(value) : value, label);
  if (jsonSha256(normalized) !== expectedSha256) {
    throw storageContractError('POSTGRES_PAYLOAD_HASH_MISMATCH', `${label} failed its stored SHA-256 check`);
  }
  return normalized;
}

function assertStorageSnapshot(snapshot) {
  if (!snapshot || snapshot.formatVersion !== 1 || !snapshot.manifestSha256) {
    throw storageContractError('INVALID_STORAGE_SNAPSHOT', 'A validated storage snapshot is required');
  }
  for (const definition of EVENT_STREAMS) {
    if (!Array.isArray(snapshot.streams?.[definition.name]?.rows)) {
      throw storageContractError('INVALID_STORAGE_SNAPSHOT', `Snapshot is missing stream ${definition.name}`);
    }
  }
  for (const definition of CONFIG_DOCUMENTS) {
    if (!snapshot.configs?.[definition.name]) {
      throw storageContractError('INVALID_STORAGE_SNAPSHOT', `Snapshot is missing config ${definition.name}`);
    }
  }
}

function assertPredicate(value, label = 'predicate') {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
}

function boundedPositiveInteger(value, fallback, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(maximum, Math.max(1, Math.floor(parsed)));
}

function dateToIso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function readinessFailureCode(error) {
  if (error?.code === '42501') return 'POSTGRES_PERMISSION_DENIED';
  if (error?.code === '28P01' || error?.code === '28000') return 'POSTGRES_AUTHENTICATION_FAILED';
  if (error?.code === '3D000') return 'POSTGRES_DATABASE_MISSING';
  return 'POSTGRES_UNREACHABLE';
}

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPostgresAdapter, initializePostgresRuntime } from '../server/postgresAdapter.mjs';
import { CONFIG_DOCUMENTS, EVENT_STREAMS } from '../server/storage/contract.mjs';
import { exportStorageSnapshotToJsonl, loadFilesystemStorageSnapshot } from '../server/storage/filesystemSnapshot.mjs';
import { applyPostgresMigrations } from '../server/storage/migrationRunner.mjs';
import { createPostgresPool, redactPostgresError } from '../server/storage/postgresConnection.mjs';
import { jsonSha256 } from '../server/storage/jsonCanonical.mjs';
import { hashRoutebookEditToken } from '../server/storage/routebookCredentials.mjs';
import { buildStorageSnapshot, compareStorageSnapshots } from '../server/storage/snapshot.mjs';
import { encodeEntityKey, publicIdEntityKey } from '../server/storage/entityKeys.mjs';

const databaseName = `trusted_routebook_store_${process.pid}_${Date.now().toString(36)}`;
const temporaryRoot = await mkdtemp(join(tmpdir(), 'trusted-routebook-postgres-'));
const sourceDir = join(temporaryRoot, 'source');
const exportDir = join(temporaryRoot, 'export');
const v1MigrationsDir = join(temporaryRoot, 'migrations-v1');
const v1MigrationPath = fileURLToPath(new URL('../server/migrations/0001_event_rows.sql', import.meta.url));
const profileIdSecret = 'postgres-storage-regression-profile-secret';
const legacyEditToken = 'rt_postgres_legacy_token_1234567890';
const nestedEditToken = 'rt_postgres_nested_token_1234567890';
const reissuedEditToken = 'rt_postgres_reissued_token_1234567890';
const legacyProfileAccessToken = 'profile_access_token_must_not_reach_postgres';
let pool;
let secondaryPool;
let adapter;
let secondaryAdapter;
let failure;

try {
  await run('createdb', ['--no-password', '--template', 'template0', '--encoding', 'UTF8', databaseName]);
  await writeFixture(sourceDir);
  await mkdir(v1MigrationsDir, { recursive: true });
  await copyFile(v1MigrationPath, join(v1MigrationsDir, '0001_event_rows.sql'));

  pool = createPostgresPool({ database: databaseName, applicationName: 'trusted-routebook-storage-regression', max: 8 });
  const v1Migration = await applyPostgresMigrations(pool, { migrationsDir: v1MigrationsDir });
  assert.deepEqual(v1Migration.applied, ['0001_event_rows.sql']);

  const historicalCredentialRoutebookId = 'historical-credential-routebook';
  const historicalCredentialRows = [
    {
      id: historicalCredentialRoutebookId,
      publicId: historicalCredentialRoutebookId,
      version: 1,
      parentVersion: null,
      title: '历史草稿'
    },
    {
      id: historicalCredentialRoutebookId,
      publicId: historicalCredentialRoutebookId,
      version: 1,
      parentVersion: null,
      title: '历史草稿',
      editReason: '补发历史草稿编辑令牌'
    }
  ];
  for (const [index, payload] of historicalCredentialRows.entries()) {
    await pool.query(
      `
      insert into trusted_routebook.event_rows (stream, ordinal, payload, payload_sha256)
      values ('routebooks', $1, $2::jsonb, $3)
    `,
      [index + 1, JSON.stringify(payload), jsonSha256(payload)]
    );
  }

  const firstMigration = await applyPostgresMigrations(pool);
  const secondMigration = await applyPostgresMigrations(pool);
  assert.deepEqual(firstMigration.applied, [
    '0002_routebook_version_cas.sql',
    '0003_profile_secret_fingerprint.sql',
    '0004_ops_audits_stream.sql',
    '0005_trip_sessions_identity_nonces.sql',
    '0006_event_row_entity_keys.sql',
    '0007_poi_merges_moderation_shadow.sql',
    '0008_accounts.sql',
    '0009_account_email.sql',
    '0010_fact_enrichment.sql',
    '0011_funnel_client_errors.sql',
    '0012_admin_config.sql'
  ]);
  assert.deepEqual(firstMigration.skipped, ['0001_event_rows.sql']);
  assert.equal(secondMigration.skipped.length, 12);
  const legacyKeyState = await pool.query(`select count(*)::int as pending from trusted_routebook.event_rows where entity_key is null`);
  assert.equal(legacyKeyState.rows[0].pending, historicalCredentialRows.length, 'rows written before 0006 keep NULL entity keys until backfilled');

  const migratedCredentialRows = await pool.query(
    `
    select routebook_version_enforced
    from trusted_routebook.event_rows
    where stream = 'routebooks'
      and coalesce(payload->>'publicId', payload->>'id') = $1
    order by ordinal
  `,
    [historicalCredentialRoutebookId]
  );
  assert.deepEqual(
    migratedCredentialRows.rows.map(({ routebook_version_enforced: enforced }) => enforced),
    [false, true],
    'schema v2 must retain historical same-version credential rows and enforce the latest one'
  );

  adapter = createPostgresAdapter({ pool, profileIdSecret });
  assert.equal((await adapter.checkReadiness()).code, 'POSTGRES_CUTOVER_NOT_READY');
  await assert.rejects(() => adapter.readJsonLines('routebooks'), { code: 'POSTGRES_CUTOVER_NOT_READY' });

  const sourceSnapshot = await loadFilesystemStorageSnapshot(sourceDir, { profileIdSecret });
  const sourceRoutebookText = JSON.stringify(sourceSnapshot.streams.routebooks.rows);
  assert.equal(sourceRoutebookText.includes(legacyEditToken), false);
  assert.equal(sourceRoutebookText.includes(nestedEditToken), false);
  assert.equal(sourceRoutebookText.includes(reissuedEditToken), false);
  assert.equal(sourceRoutebookText.includes(legacyProfileAccessToken), false);
  assert.equal(sourceSnapshot.streams.routebooks.rows[0].editTokenHash, hashRoutebookEditToken(legacyEditToken, { profileIdSecret }));
  assert.equal(sourceSnapshot.streams.routebooks.rows[0].nested.editTokenHash, hashRoutebookEditToken(nestedEditToken, { profileIdSecret }));
  const backfill = await adapter.replaceWithFilesystemSnapshot(sourceSnapshot);
  assert.equal(backfill.rows, EVENT_STREAMS.length * 2);
  assert.equal(backfill.configs, CONFIG_DOCUMENTS.length);
  assert.equal((await adapter.checkReadiness()).ready, false);
  const storedRoutebookRows = await pool.query(`
    select payload, routebook_version_enforced
    from trusted_routebook.event_rows
    where stream = 'routebooks'
    order by ordinal
  `);
  const storedRoutebookText = JSON.stringify(storedRoutebookRows.rows);
  assert.equal(storedRoutebookText.includes(legacyEditToken), false);
  assert.equal(storedRoutebookText.includes(nestedEditToken), false);
  assert.equal(storedRoutebookText.includes(reissuedEditToken), false);
  assert.equal(storedRoutebookText.includes(legacyProfileAccessToken), false);
  assert.equal(storedRoutebookRows.rows[0].payload.editTokenHash, hashRoutebookEditToken(legacyEditToken, { profileIdSecret }));
  assert.deepEqual(
    storedRoutebookRows.rows.map(({ routebook_version_enforced: enforced }) => enforced),
    [false, true],
    'snapshot backfill must retain a same-version credential issuance row without weakening future uniqueness'
  );

  const mismatchedSnapshot = buildStorageSnapshot({
    source: 'intentional-parity-mismatch',
    streams: Object.fromEntries(
      EVENT_STREAMS.map((definition) => [
        definition.name,
        {
          present: true,
          rows:
            definition.name === 'routebooks'
              ? [...sourceSnapshot.streams[definition.name].rows, { id: 'unexpected-routebook' }]
              : sourceSnapshot.streams[definition.name].rows
        }
      ])
    ),
    configs: Object.fromEntries(CONFIG_DOCUMENTS.map((definition) => [definition.name, sourceSnapshot.configs[definition.name]]))
  });
  await assert.rejects(() => adapter.compareFilesystemSnapshot(mismatchedSnapshot, { markReady: true }), { code: 'POSTGRES_PARITY_MISMATCH' });
  assert.equal((await adapter.checkReadiness()).ready, false, 'failed parity must keep readiness closed');

  const parity = await adapter.compareFilesystemSnapshot(sourceSnapshot);
  assert.equal(parity.matches, true);
  assert.equal(parity.markedReady, false);
  const cutover = await adapter.compareFilesystemSnapshot(sourceSnapshot, { markReady: true });
  assert.equal(cutover.matches, true);
  assert.equal(cutover.markedReady, true);
  const readiness = await adapter.checkReadiness();
  assert.equal(readiness.ready, true);
  assert.equal(readiness.schemaVersion, 12);
  const wrongSecretAdapter = createPostgresAdapter({
    pool,
    profileIdSecret: 'postgres-storage-regression-wrong-secret'
  });
  assert.equal((await wrongSecretAdapter.checkReadiness()).code, 'POSTGRES_PROFILE_SECRET_MISMATCH');

  const routebookVersionIndex = await pool.query(`
    select to_regclass('trusted_routebook.event_rows_routebook_entity_version_uidx') is not null as present
  `);
  assert.equal(routebookVersionIndex.rows[0].present, true);

  secondaryPool = createPostgresPool({
    database: databaseName,
    applicationName: 'trusted-routebook-storage-regression-secondary',
    max: 8
  });
  secondaryAdapter = createPostgresAdapter({ pool: secondaryPool, profileIdSecret });
  assert.equal((await secondaryAdapter.checkReadiness()).ready, true);

  const initialized = await initializePostgresRuntime({
    pool,
    storageBackend: 'postgres',
    profileIdSecret
  });
  assert.equal((await initialized.checkReadiness()).ready, true);
  await initialized.close();

  const latestRoutebooks = await adapter.readJsonLines('routebooks', 2);
  assert.deepEqual(
    latestRoutebooks.map((row) => row.index),
    [2, 1]
  );
  assert.equal(
    (await adapter.findLatestJsonLine('routebooks', (row) => row.index === 1, 1)).index,
    1,
    'predicate reads must not lose an older entity behind a tail window'
  );

  const routebookId = 'postgres-cas-routebook';
  const createdRoutebook = await adapter.appendVersionedRoutebook(
    {
      id: routebookId,
      publicId: routebookId,
      version: 1,
      parentVersion: null,
      title: 'CAS 初始版本'
    },
    { expectedVersion: 0 }
  );
  assert.equal(createdRoutebook.currentVersion, 1);

  const competingRoutebooks = [
    { title: 'CAS 竞争版本 A', writer: 'primary' },
    { title: 'CAS 竞争版本 B', writer: 'secondary' }
  ].map((item) => ({
    id: routebookId,
    publicId: routebookId,
    version: 2,
    parentVersion: 1,
    ...item
  }));
  const competingResults = await Promise.allSettled([
    adapter.appendVersionedRoutebook(competingRoutebooks[0], { expectedVersion: 1 }),
    secondaryAdapter.appendVersionedRoutebook(competingRoutebooks[1], { expectedVersion: 1 })
  ]);
  const successfulCasWrites = competingResults.filter((result) => result.status === 'fulfilled');
  const rejectedCasWrites = competingResults.filter((result) => result.status === 'rejected');
  assert.equal(successfulCasWrites.length, 1, 'exactly one concurrent v2 write must succeed');
  assert.equal(rejectedCasWrites.length, 1, 'the stale concurrent v2 write must be rejected');
  assert.equal(rejectedCasWrites[0].reason.code, 'ROUTEBOOK_VERSION_CONFLICT');
  assert.equal(rejectedCasWrites[0].reason.currentVersion, 2);

  const storedCasRows = await pool.query(
    `
    select payload
    from trusted_routebook.event_rows
    where stream = 'routebooks'
      and coalesce(payload->>'publicId', payload->>'id') = $1
    order by ordinal
  `,
    [routebookId]
  );
  assert.deepEqual(
    storedCasRows.rows.map(({ payload }) => Number(payload.version)),
    [1, 2]
  );

  const duplicateVersion = {
    ...successfulCasWrites[0].value.payload,
    title: '绕过 adapter 的重复 v2'
  };
  await assert.rejects(
    () =>
      pool.query(
        `
      insert into trusted_routebook.event_rows (stream, ordinal, payload, payload_sha256)
      select 'routebooks', coalesce(max(ordinal), 0) + 1, $1::jsonb, $2
      from trusted_routebook.event_rows
      where stream = 'routebooks'
    `,
        [JSON.stringify(duplicateVersion), jsonSha256(duplicateVersion)]
      ),
    (/** @type {any} */ error) => error?.code === '23505' && error?.constraint === 'event_rows_routebook_entity_version_uidx'
  );

  const lockSequence = [];
  /** @type {(value?: unknown) => void} */
  let releaseFirstLock;
  /** @type {(value?: unknown) => void} */
  let markFirstLockEntered;
  const firstLockEntered = new Promise((resolve) => {
    markFirstLockEntered = resolve;
  });
  const holdFirstLock = new Promise((resolve) => {
    releaseFirstLock = resolve;
  });
  const firstLock = adapter.withEntityMutationLock('profile', 'serialized-profile', async () => {
    lockSequence.push('first:start');
    markFirstLockEntered();
    await adapter.readJsonLines('profiles', 1);
    await holdFirstLock;
    lockSequence.push('first:end');
  });
  await firstLockEntered;
  const secondLock = secondaryAdapter.withEntityMutationLock('profile', 'serialized-profile', async () => {
    lockSequence.push('second:start');
    await secondaryAdapter.readJsonLines('profiles', 1);
    lockSequence.push('second:end');
  });
  await waitForBlockedAdvisoryLock(pool);
  assert.deepEqual(lockSequence, ['first:start']);
  releaseFirstLock();
  await Promise.all([firstLock, secondLock]);
  assert.deepEqual(lockSequence, ['first:start', 'first:end', 'second:start', 'second:end']);

  const distinctProfileLocks = await withTimeout(
    Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        adapter.withEntityMutationLock('profile', `pool-capacity-profile-${index}`, async () => {
          const rows = await adapter.withEntityMutationLock('trip', `nested-trip-${index}`, () => adapter.readJsonLines('profiles', 1));
          return rows.length;
        })
      )
    ),
    10_000,
    'entity mutation locks exhausted the pool while their operations needed nested reads'
  );
  assert.equal(distinctProfileLocks.length, 12);

  const snapshotBarrier = createSnapshotBarrierPool(pool, 'ai-logs');
  const snapshotAdapter = createPostgresAdapter({
    pool: snapshotBarrier.pool,
    profileIdSecret
  });
  const isolatedSnapshotPromise = snapshotAdapter.loadStorageSnapshot();
  await snapshotBarrier.firstStreamRead;
  const snapshotMarker = `snapshot-${Date.now().toString(36)}`;
  const snapshotAiLog = {
    kind: 'snapshot-concurrency',
    marker: snapshotMarker,
    modelUsage: {
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
      attemptCount: 1,
      reportedAttemptCount: 1,
      status: 'reported'
    },
    stages: {
      model: { durationMs: 250, status: 'completed', timedOut: false },
      geocoding: { durationMs: 40, status: 'degraded', timedOut: true },
      routing: { durationMs: 80, status: 'completed', timedOut: false },
      persistence: { durationMs: 10, status: 'completed', timedOut: false }
    },
    costEstimate: {
      status: 'estimated',
      model: 'snapshot-model',
      currency: 'CNY',
      amount: 0.00042,
      inputPricePerMillion: 1,
      outputPricePerMillion: 10,
      basis: 'environment-price-snapshot'
    }
  };
  try {
    await Promise.all([
      adapter.appendJsonLine('ai-logs', snapshotAiLog),
      secondaryAdapter.appendJsonLine('checkins', { kind: 'snapshot-concurrency', marker: snapshotMarker })
    ]);
  } finally {
    snapshotBarrier.release();
  }
  const isolatedSnapshot = await isolatedSnapshotPromise;
  assert.equal(snapshotContainsMarker(isolatedSnapshot, 'ai-logs', snapshotMarker), false);
  assert.equal(snapshotContainsMarker(isolatedSnapshot, 'checkins', snapshotMarker), false);
  const postWriteSnapshot = await adapter.loadStorageSnapshot();
  assert.equal(snapshotContainsMarker(postWriteSnapshot, 'ai-logs', snapshotMarker), true);
  assert.equal(snapshotContainsMarker(postWriteSnapshot, 'checkins', snapshotMarker), true);
  const persistedAiLog = postWriteSnapshot.streams['ai-logs'].rows.find((row) => row?.marker === snapshotMarker);
  assert.deepEqual(persistedAiLog?.modelUsage, snapshotAiLog.modelUsage);
  assert.deepEqual(persistedAiLog?.stages, snapshotAiLog.stages);
  assert.deepEqual(persistedAiLog?.costEstimate, snapshotAiLog.costEstimate);
  const opsAuditMarker = `ops-audit-${Date.now().toString(36)}`;
  await adapter.appendJsonLine('ops-audits', {
    id: opsAuditMarker,
    entityType: 'checkin',
    entityId: 'postgres-fixture-checkin',
    action: 'exclude',
    reason: '存储回归验证',
    actor: 'postgres-regression',
    createdAt: new Date().toISOString(),
    state: { excluded: true, commercialIncentive: false }
  });
  assert.equal((await adapter.readJsonLines('ops-audits', 1))[0].id, opsAuditMarker);

  const concurrentRows = await Promise.all(Array.from({ length: 20 }, (_, index) => adapter.appendJsonLine('clicks', { kind: 'concurrent', index })));
  assert.equal(new Set(concurrentRows.map((row) => row.ordinal)).size, 20);
  const clickOrdinals = await pool.query(`
    select ordinal
    from trusted_routebook.event_rows
    where stream = 'clicks'
    order by ordinal
  `);
  assert.deepEqual(
    clickOrdinals.rows.map((row) => Number(row.ordinal)),
    Array.from({ length: 22 }, (_, index) => index + 1),
    'concurrent appends must allocate a gap-free per-stream order'
  );

  assert.equal(await adapter.rewriteJsonlExcluding('clicks', (row) => row.kind === 'concurrent' && row.index % 2 === 0), 10);
  assert.equal((await adapter.readJsonLines('clicks', 100)).length, 12);
  const configWrite = await adapter.writeConfigDocument('cms-config', { enabled: false, nested: { version: 2 } });
  assert.equal(configWrite.revision, 2);
  assert.deepEqual((await adapter.readConfigDocument('cms-config')).document, {
    enabled: false,
    nested: { version: 2 }
  });

  await assert.rejects(() => adapter.replaceWithFilesystemSnapshot(sourceSnapshot), { code: 'POSTGRES_ONLINE_BACKFILL_FORBIDDEN' });
  await assert.rejects(() => adapter.replaceWithFilesystemSnapshot(sourceSnapshot, { force: true }), { code: 'POSTGRES_ONLINE_BACKFILL_FORBIDDEN' });
  await assert.rejects(
    () =>
      pool.query(`
      insert into trusted_routebook.event_rows (stream, ordinal, payload, payload_sha256)
      values ('unknown-stream', 1, '{}'::jsonb, repeat('a', 64))
    `),
    /event_rows_stream_check/
  );

  const databaseSnapshot = await adapter.loadStorageSnapshot();
  await exportStorageSnapshotToJsonl(databaseSnapshot, exportDir, { profileIdSecret });
  const exportedSnapshot = await loadFilesystemStorageSnapshot(exportDir, { profileIdSecret });
  assert.deepEqual(compareStorageSnapshots(databaseSnapshot, exportedSnapshot).differences, []);
  assert.equal(
    exportedSnapshot.streams['ops-audits'].rows.some((row) => row.id === opsAuditMarker),
    true,
    'ops-audits must survive PostgreSQL snapshot export and filesystem parity reload'
  );

  const tableCount = await pool.query(`
    select count(*)::integer as count
    from pg_catalog.pg_tables
    where schemaname = 'trusted_routebook'
      and tablename in ('schema_migrations', 'event_rows', 'config_documents', 'storage_state')
  `);
  assert.equal(tableCount.rows[0].count, 4);

  await pool.query(`
    update trusted_routebook.storage_state
    set phase = 'backfilled', cutover_ready = false, updated_at = clock_timestamp()
    where singleton_id = 1
  `);
  await assert.rejects(() => adapter.appendJsonLine('clicks', { kind: 'must-not-write-after-readiness-revoked' }), { code: 'POSTGRES_CUTOVER_NOT_READY' });
  await pool.query(`
    update trusted_routebook.storage_state
    set phase = 'ready', cutover_ready = true, updated_at = clock_timestamp()
    where singleton_id = 1
  `);

  // --- Migration 0006: entity keys -------------------------------------------
  // Snapshot backfill and runtime appends compute entity_key in JS.
  const unkeyedAfterBackfill = await pool.query(`select count(*)::int as pending from trusted_routebook.event_rows where entity_key is null`);
  assert.equal(unkeyedAfterBackfill.rows[0].pending, 0, 'snapshot backfill and appends must store entity keys');
  const keyedRoutebook = await pool.query(
    `select entity_key from trusted_routebook.event_rows where stream = 'routebooks' and payload->>'id' = $1 order by ordinal desc limit 1`,
    [routebookId]
  );
  assert.equal(keyedRoutebook.rows[0].entity_key, routebookId);

  // Simulate rows written by a binary that predates 0006 (entity_key NULL):
  // lookups must still see them before the backfill runs.
  const legacyAppend = async (stream, payload) => {
    await pool.query(
      `insert into trusted_routebook.event_rows (stream, ordinal, payload, payload_sha256)
       select $1, coalesce(max(ordinal), 0) + 1, $2::jsonb, $3 from trusted_routebook.event_rows where stream = $1`,
      [stream, JSON.stringify(payload), jsonSha256(payload)]
    );
  };
  const legacyRoutebookId = 'entity-key-legacy-routebook';
  await adapter.appendJsonLine('routebooks', { id: legacyRoutebookId, publicId: legacyRoutebookId, title: '键控前写入 v1', publishStatus: 'draft' });
  await legacyAppend('routebooks', { id: legacyRoutebookId, publicId: legacyRoutebookId, title: '旧二进制写入 v2', publishStatus: 'draft' });
  await legacyAppend('profiles', { id: 'p_entity_key_legacy', registrationCredentialHash: 'legacy-registration-hash' });
  assert.equal((await adapter.findLatestByEntityKey('routebooks', legacyRoutebookId)).title, '旧二进制写入 v2', 'NULL-key rows are evaluated in JS');
  assert.equal((await adapter.findLatestByEntityKey('profiles', 'p_entity_key_legacy')).registrationCredentialHash, 'legacy-registration-hash');
  assert.equal(await adapter.findLatestByEntityKey('routebooks', 'entity-key-missing'), null);
  const fullScanReference = async () =>
    adapter.readLatestUniqueJsonLines(
      'routebooks',
      (row) => publicIdEntityKey(row),
      1000,
      50000,
      (row) => row.publishStatus !== 'archived'
    );
  const keyedListBeforeBackfill = await adapter.readLatestUniqueJsonLines(
    'routebooks',
    publicIdEntityKey,
    1000,
    50000,
    (row) => row.publishStatus !== 'archived'
  );
  assert.deepEqual(keyedListBeforeBackfill, await fullScanReference(), 'pending keys fall back to the exact full scan');

  const entityKeyBackfill = await adapter.backfillEntityKeys({ batchSize: 2 });
  assert.equal(entityKeyBackfill.updated, 2);
  assert.equal((await adapter.backfillEntityKeys()).updated, 0, 'backfill is idempotent');
  assert.equal((await adapter.findLatestByEntityKey('routebooks', legacyRoutebookId)).title, '旧二进制写入 v2');
  // Latest-per-key wins even when the predicate rejects it (same as JSONL H4).
  await adapter.appendJsonLine('routebooks', { id: legacyRoutebookId, publicId: legacyRoutebookId, title: '已归档 v3', publishStatus: 'archived' });
  const keyedList = await adapter.readLatestUniqueJsonLines('routebooks', publicIdEntityKey, 1000, 50000, (row) => row.publishStatus !== 'archived');
  assert.deepEqual(keyedList, await fullScanReference(), 'index-backed latest-unique list equals the full scan');
  assert.equal(
    keyedList.some((row) => publicIdEntityKey(row) === legacyRoutebookId),
    false,
    'an archived latest snapshot must hide older versions'
  );
  assert.deepEqual(
    (await adapter.readLatestUniqueJsonLines('routebooks', publicIdEntityKey, 1)).map(publicIdEntityKey),
    [legacyRoutebookId],
    'limit applies after per-key de-duplication, newest first'
  );

  // Secondary key: registration credential hash (latest row wins).
  await adapter.appendJsonLine('profiles', { id: 'p_entity_key_registered', registrationCredentialHash: 'registration-hash-a', revision: 1 });
  await adapter.appendJsonLine('profiles', { id: 'p_entity_key_registered', registrationCredentialHash: 'registration-hash-a', revision: 2 });
  assert.equal((await adapter.findLatestBySecondaryKey('profiles', 'registrationCredentialHash', 'registration-hash-a')).revision, 2);
  assert.equal((await adapter.findLatestBySecondaryKey('profiles', 'registrationCredentialHash', 'legacy-registration-hash')).id, 'p_entity_key_legacy');
  assert.equal(await adapter.findLatestBySecondaryKey('profiles', 'registrationCredentialHash', 'unknown-hash'), null);
  await assert.rejects(() => adapter.findLatestBySecondaryKey('profiles', 'payload', 'x'), { code: 'SECONDARY_KEY_UNSUPPORTED' });

  // Over-long keys are stored hashed and still resolve exactly.
  const longNonceKey = `nonce:${'x'.repeat(400)}`;
  await adapter.appendJsonLine('identity-nonces', { key: longNonceKey, consumedAt: 'now' });
  assert.equal((await adapter.findLatestByEntityKey('identity-nonces', longNonceKey)).key, longNonceKey);
  const longKeyRow = await pool.query(`select entity_key from trusted_routebook.event_rows where stream = 'identity-nonces' order by ordinal desc limit 1`);
  assert.equal(longKeyRow.rows[0].entity_key, encodeEntityKey(longNonceKey));
  assert.match(longKeyRow.rows[0].entity_key, /^sha256:[0-9a-f]{64}$/);

  // The planner can serve keyed lookups from the new indexes.
  const planClient = await pool.connect();
  try {
    await planClient.query('set enable_seqscan = off');
    const keyedPlan = await planClient.query(
      `explain select payload from trusted_routebook.event_rows where stream = 'routebooks' and entity_key = $1 order by ordinal desc limit 1`,
      [legacyRoutebookId]
    );
    assert.match(keyedPlan.rows.map((row) => row['QUERY PLAN']).join('\n'), /event_rows_stream_entity_key_idx/);
    const registrationPlan = await planClient.query(
      `explain select payload from trusted_routebook.event_rows where stream = 'profiles' and payload->>'registrationCredentialHash' = $1 order by ordinal desc limit 1`,
      ['registration-hash-a']
    );
    assert.match(registrationPlan.rows.map((row) => row['QUERY PLAN']).join('\n'), /event_rows_profile_registration_hash_idx/);
  } finally {
    planClient.release();
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      migrations: firstMigration.total,
      streams: EVENT_STREAMS.length,
      configs: CONFIG_DOCUMENTS.length,
      backfilledRows: backfill.rows,
      concurrentAppends: concurrentRows.length,
      routebookCasWinner: successfulCasWrites[0].value.payload.writer,
      entityMutationLockSerialized: true,
      entityMutationPoolCapacityProtected: true,
      repeatableReadSnapshot: true,
      historicalDuplicateVersionsPreserved: true,
      entityKeyLookups: true,
      entityKeyLegacyRowsBackfilled: entityKeyBackfill.updated,
      exportManifestSha256: exportedSnapshot.manifestSha256
    })}\n`
  );
} catch (error) {
  failure = error;
} finally {
  await secondaryAdapter?.close().catch(() => {});
  await adapter?.close().catch(() => {});
  await secondaryPool?.end().catch(() => {});
  await pool?.end().catch(() => {});
  const cleanup = await run('dropdb', ['--no-password', '--if-exists', '--force', databaseName], { allowFailure: true }).catch((/** @type {any} */ error) => ({
    code: 1,
    stderr: error.message,
    stdout: ''
  }));
  await rm(temporaryRoot, { recursive: true, force: true }).catch(() => {});
  if (cleanup.code !== 0 && !failure) {
    failure = new Error(`temporary database cleanup failed: ${redactPostgresError(cleanup.stderr || cleanup.stdout)}`);
  }
}

if (failure) {
  process.stderr.write(`PostgreSQL storage regression failed: ${redactPostgresError(failure.stack || failure.message)}\n`);
  process.exitCode = 1;
}

async function waitForBlockedAdvisoryLock(queryable, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await queryable.query(`
      select count(*)::integer as count
      from pg_catalog.pg_locks
      where locktype = 'advisory'
        and database = (select oid from pg_catalog.pg_database where datname = current_database())
        and granted = false
    `);
    if (result.rows[0].count > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('second entity mutation lock did not block on the first session lock');
}

function createSnapshotBarrierPool(pool, firstStream) {
  let markFirstStreamRead;
  /** @type {(value?: unknown) => void} */
  let releaseSnapshot;
  let intercepted = false;
  const firstStreamRead = new Promise((resolve) => {
    markFirstStreamRead = resolve;
  });
  const resumeSnapshot = new Promise((resolve) => {
    releaseSnapshot = resolve;
  });
  return {
    firstStreamRead,
    release: releaseSnapshot,
    pool: {
      options: pool.options,
      query: (...args) => pool.query(...args),
      async connect() {
        const client = await pool.connect();
        return {
          async query(sql, parameters) {
            const result = await client.query(sql, parameters);
            if (!intercepted && parameters?.[0] === firstStream && String(sql).includes(`from trusted_routebook.event_rows`)) {
              intercepted = true;
              markFirstStreamRead();
              await resumeSnapshot;
            }
            return result;
          },
          release: (...args) => client.release(...args)
        };
      }
    }
  };
}

function snapshotContainsMarker(snapshot, stream, marker) {
  return snapshot.streams[stream].rows.some((row) => row?.marker === marker);
}

function withTimeout(promise, timeoutMs, message) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

async function writeFixture(directory) {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const definition of EVENT_STREAMS) {
    const rows = [
      { stream: definition.name, index: 1, title: '旧实体', nested: { b: 2, a: 1 } },
      { nested: { a: 2, b: 3 }, index: 2, stream: definition.name, title: '最新实体' }
    ];
    if (definition.name === 'routebooks') {
      rows[0] = {
        ...rows[0],
        id: 'fixture-credential-routebook',
        publicId: 'fixture-credential-routebook',
        version: 1,
        parentVersion: null,
        editToken: legacyEditToken,
        profileAccessToken: legacyProfileAccessToken,
        nested: {
          ...rows[0].nested,
          editToken: nestedEditToken,
          profileAccessToken: legacyProfileAccessToken
        }
      };
      rows[1] = {
        ...rows[1],
        id: 'fixture-credential-routebook',
        publicId: 'fixture-credential-routebook',
        version: 1,
        parentVersion: null,
        editToken: reissuedEditToken,
        editReason: '补发历史草稿编辑令牌'
      };
    }
    await writeFile(join(directory, definition.fileName), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  await writeFile(join(directory, 'cms-config.json'), '{"nested":{"version":1},"enabled":true}\n', { mode: 0o600 });
  await writeFile(join(directory, 'product-config.json'), '{"products":[{"id":"p-1"}]}\n', { mode: 0o600 });
}

function run(command, args, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, PGCONNECT_TIMEOUT: process.env.PGCONNECT_TIMEOUT || '5' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', (/** @type {any} */ error) => reject(error));
    child.once('close', (code, signal) => {
      const result = { code, signal, stdout, stderr };
      if (code === 0 || allowFailure) resolve(result);
      else reject(new Error(`${command} failed: ${redactPostgresError(stderr || stdout || `exit ${code}`)}`));
    });
  });
}

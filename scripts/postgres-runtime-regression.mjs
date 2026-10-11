// End-to-end PostgreSQL cutover and two live app instances. Only temporary data
// and a fresh local database are used; no model/provider requests are made.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPostgresAdapter } from '../server/postgresAdapter.mjs';
import { loadFilesystemStorageSnapshot } from '../server/storage/filesystemSnapshot.mjs';
import { applyPostgresMigrations } from '../server/storage/migrationRunner.mjs';
import { createPostgresPool } from '../server/storage/postgresConnection.mjs';
import { hermeticServerEnv } from './lib/hermetic-env.mjs';

const database = `lushu_runtime_${process.pid}_${Date.now().toString(36)}`;
const dataDir = await mkdtemp(join(tmpdir(), 'lushu-pg-runtime-'));
const profileSecret = 'postgres-runtime-profile-secret';
const identitySecret = 'postgres-runtime-identity-secret';
const adminToken = 'postgres-runtime-admin-token';
const children = [];
let pool;
let created = false;

async function run(command, args) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (data) => {
    output += data;
  });
  child.stderr.on('data', (data) => {
    output += data;
  });
  const [code] = await once(child, 'exit');
  if (code !== 0) throw new Error(`${command} exited ${code}: ${output}`);
  return output;
}

async function freePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = /** @type {import('node:net').AddressInfo} */ (probe.address()).port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** @param {string} base @param {string} path @param {{method?:string,body?:any,profile?:any,admin?:boolean}} options */
async function request(base, path, { method = 'GET', body, profile, admin = false } = {}) {
  const response = await fetch(`${base}/api${path}`, {
    method,
    signal: AbortSignal.timeout(15000),
    headers: {
      'content-type': 'application/json',
      ...(profile ? { 'x-routebook-profile-id': profile.id, 'x-routebook-profile-token': profile.profileAccessToken } : {}),
      ...(admin ? { 'x-routebook-admin-token': adminToken } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  return { status: response.status, data: await response.json().catch(() => ({})) };
}

async function startInstance(label) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.mjs', '--production'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: hermeticServerEnv({
      STORAGE_BACKEND: 'postgres',
      ...postgresClientEnv,
      PGDATABASE: database,
      POSTGRES_URL: '',
      DATABASE_URL: '',
      PROFILE_ID_SECRET: profileSecret,
      PROFILE_IDENTITY_ASSERTION_SECRET: identitySecret,
      ROUTEBOOK_ADMIN_TOKEN: adminToken,
      ROUTEBOOK_DATA_DIR: dataDir,
      HOST: '127.0.0.1',
      PORT: String(port),
      ALLOW_LOCAL_API_BYPASS: 'false',
      ALLOW_LOCAL_ADMIN_BYPASS: 'false',
      RATE_LIMIT_MAX: '1000',
      RATE_LIMIT_CORE_WRITE_MAX: '1000',
      RATE_LIMIT_PUBLIC_READ_MAX: '1000',
      POSTGRES_POOL_MAX: '2'
    })
  });
  const state = { child, label, base, logs: '' };
  children.push(state);
  child.stdout.on('data', (data) => {
    state.logs += data;
  });
  child.stderr.on('data', (data) => {
    state.logs += data;
  });
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (child.exitCode != null) throw new Error(`${label} exited: ${state.logs}`);
    try {
      const result = await request(base, '/health', { admin: true });
      // `ready` is per-caller (needs model access); this instance has no API token, so wait on the model runtime.
      if (result.status === 200 && result.data.modelReady) return state;
    } catch {
      /* Starting local process. */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label} did not become ready: ${state.logs}`);
}

// Honour the standard libpq environment (CI uses PGHOST=127.0.0.1 + password
// auth); fall back to the /tmp socket only when nothing is configured.
const postgresClientEnv = Object.fromEntries(
  ['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD'].filter((key) => process.env[key]).map((key) => [key, process.env[key]])
);
if (!postgresClientEnv.PGHOST) postgresClientEnv.PGHOST = '/tmp';

function identity(phone, nonce) {
  const issuedAt = new Date().toISOString();
  const signature = createHmac('sha256', identitySecret).update(`trusted-routebook:phone:${phone}:${issuedAt}:${nonce}`).digest('hex');
  return { type: 'phone', phone, proof: { issuedAt, nonce, signature } };
}

try {
  await run('createdb', ['--host', postgresClientEnv.PGHOST, '--no-password', '--template', 'template0', '--encoding', 'UTF8', database]);
  created = true;
  pool = createPostgresPool({ connectionString: '', environment: {}, host: postgresClientEnv.PGHOST, database, applicationName: 'lushu-runtime-regression' });
  await applyPostgresMigrations(pool);
  const adapter = createPostgresAdapter({ pool, profileIdSecret: profileSecret });
  const snapshot = await loadFilesystemStorageSnapshot(dataDir, { profileIdSecret: profileSecret });
  await adapter.replaceWithFilesystemSnapshot(snapshot);
  assert.equal((await adapter.compareFilesystemSnapshot(snapshot, { markReady: true })).matches, true);
  assert.equal((await adapter.checkReadiness()).ready, true);
  const instanceA = await startInstance('A');
  const instanceB = await startInstance('B');
  const a = instanceA.base;
  const b = instanceB.base;

  const registration = { id: 'p_runtime_local_owner', pendingRegistrationSecret: `preg_${'b'.repeat(43)}`, creatorName: 'PG运行态测试' };
  const registered = await request(a, '/profile', { method: 'POST', body: registration });
  assert.equal(registered.status, 200, JSON.stringify(registered.data));
  const profile = registered.data.profile;
  const replay = await request(b, '/profile', { method: 'POST', body: registration });
  assert.equal(replay.status, 200, JSON.stringify(replay.data));
  assert.equal(replay.data.profile.id, profile.id);
  assert.equal(replay.data.profile.profileAccessToken, profile.profileAccessToken);

  const shared = await request(a, '/share/hangzhou-westlake-tea');
  const stops = shared.data.routebook.stops.slice(0, 3);
  const routeId = `pg-runtime-route-${Date.now()}`;
  const draft = {
    id: routeId,
    publicId: routeId,
    title: 'PostgreSQL双实例测试路书',
    city: '杭州',
    days: ['Day 1'],
    stops,
    profileId: profile.id,
    editToken: 'rt_runtime_test_token_1234567890',
    expectedVersion: 0
  };
  const saved = await request(a, '/routebooks', { method: 'POST', profile, body: draft });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const readOnB = await request(b, `/routebooks/${routeId}`, { profile });
  assert.equal(readOnB.status, 200, JSON.stringify(readOnB.data));
  assert.equal(readOnB.data.routebook.title, draft.title);
  const concurrentDrafts = await Promise.all(
    [a, b].map((base, index) => request(base, '/routebooks', { method: 'POST', profile, body: { ...draft, title: `CAS胜出${index}`, expectedVersion: 1 } }))
  );
  assert.deepEqual(concurrentDrafts.map((result) => result.status).sort(), [200, 409], JSON.stringify(concurrentDrafts));
  assert.equal((await request(b, `/routebooks/${routeId}`, { profile })).data.routebook.version, 2);
  const tokenOnlySave = await request(b, '/routebooks', { method: 'POST', body: { ...draft, profileId: 'anonymous', expectedVersion: 2 } });
  assert.equal(tokenOnlySave.status, 200, JSON.stringify(tokenOnlySave.data));
  assert.equal(tokenOnlySave.data.routebook.profileId, profile.id, 'edit-token write must retain original registered owner');

  const tripPath = `/trip-sessions/${routeId}`;
  const trip = { profileId: profile.id, stops, currentStopId: String(stops[0].id), expectedRevision: 0 };
  assert.equal((await request(a, tripPath, { method: 'POST', profile, body: trip })).status, 200);
  const tripOnB = await request(b, `${tripPath}?profileId=${profile.id}`, { profile });
  assert.equal(tripOnB.data.session.revision, 1);
  const concurrentTrips = await Promise.all([a, b].map((base) => request(base, tripPath, { method: 'POST', profile, body: { ...trip, expectedRevision: 1 } })));
  assert.deepEqual(concurrentTrips.map((result) => result.status).sort(), [200, 409], JSON.stringify(concurrentTrips));

  // Warm B's in-memory nonce cache before A consumes a new assertion. A process
  // restart-only check would miss this multi-instance replay case.
  assert.equal((await request(b, '/profile', { method: 'POST', body: { identity: identity('13800138001', 'pg_nonce_warmup') } })).status, 200);
  const assertion = identity('13800138002', 'pg_nonce_cross_instance');
  assert.equal((await request(a, '/profile', { method: 'POST', body: { identity: assertion } })).status, 200);
  const nonceReplay = await request(b, '/profile', { method: 'POST', body: { identity: assertion } });
  assert.equal(nonceReplay.status, 409, JSON.stringify(nonceReplay.data));
  assert.equal(nonceReplay.data.code, 'IDENTITY_ASSERTION_REPLAYED');

  await request(b, '/pois?city=杭州', { admin: true });
  const poi = {
    poiId: `poi-pg-runtime-${Date.now()}`,
    city: '杭州',
    name: '双实例目录刷新测试点',
    location: { lat: 30.244, lng: 120.161 },
    sourceType: 'official',
    reviewStatus: 'pending',
    facts: [],
    evidence: [],
    audits: []
  };
  const validation = await request(a, '/pois/validate', { method: 'POST', admin: true, body: { rows: [poi] } });
  assert.equal(validation.data.canCommit, true, JSON.stringify(validation.data));
  const committed = await request(a, '/pois/upsert', {
    method: 'POST',
    admin: true,
    body: { rows: [poi], batchId: validation.data.batchId, commitToken: validation.data.commitToken }
  });
  assert.equal(committed.status, 200, JSON.stringify(committed.data));
  let visibleOnB = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = await request(b, '/pois?city=杭州', { admin: true });
    if (result.data.pois?.some((item) => item.poiId === poi.poiId)) {
      visibleOnB = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(visibleOnB, true, 'POI catalog writes must become visible across instances');

  const deleted = await request(a, '/profile', { method: 'DELETE', profile, body: { profileId: profile.id, confirmation: 'DELETE' } });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
  assert.equal((await request(b, `${tripPath}?profileId=${profile.id}`, { profile })).status, 410);
  assert.equal((await request(b, '/profile', { method: 'POST', body: profile })).status, 410);
  const staleTokenSave = await request(b, '/routebooks', { method: 'POST', body: { ...draft, profileId: 'anonymous', expectedVersion: 3 } });
  // Deleted with the profile: tombstoned id, so a stale copy gets a clear 410 instead of a generic 403.
  assert.equal(staleTokenSave.status, 410, JSON.stringify(staleTokenSave.data));
  assert.equal(staleTokenSave.data.code, 'ROUTEBOOK_DELETED');
  const listedAfterDeletion = await request(b, '/routebooks', { admin: true });
  assert.equal(listedAfterDeletion.status, 200);
  assert.equal(
    listedAfterDeletion.data.routebooks.some((book) => book.id === routeId),
    false
  );
  assert.equal((await request(b, `/routebooks/${routeId}`, { admin: true })).status, 410);
  const survivingOwnedRows = await pool.query(
    "select count(*)::int as count from trusted_routebook.event_rows where stream <> 'profiles' and payload->>'profileId'=$1",
    [profile.id]
  );
  assert.equal(survivingOwnedRows.rows[0].count, 0);
  // Upgrade re-run of the one-shot migrate service on a cut-over database with live data: migrate applies
  // nothing, backfill and parity --mark-ready skip cleanly (exit 0) instead of failing on
  // POSTGRES_ONLINE_BACKFILL_FORBIDDEN.
  for (const instance of children) {
    instance.child.kill('SIGTERM');
    if (instance.child.exitCode == null) await once(instance.child, 'exit');
  }
  const scriptEnv = { ...process.env, ...postgresClientEnv, PGDATABASE: database, POSTGRES_URL: '', DATABASE_URL: '', PROFILE_ID_SECRET: profileSecret };
  const runScript = async (args) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env: scriptEnv });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => (stdout += data));
    child.stderr.on('data', (data) => (stderr += data));
    const [code] = await once(child, 'exit');
    return { code, stdout, stderr };
  };
  const migrated = await runScript(['scripts/postgres-migrate.mjs']);
  assert.equal(migrated.code, 0, migrated.stderr);
  assert.deepEqual(JSON.parse(migrated.stdout).applied, []);
  for (const args of [
    ['scripts/postgres-backfill.mjs', '--data-dir', dataDir, '--apply'],
    ['scripts/postgres-parity.mjs', '--data-dir', dataDir, '--mark-ready']
  ]) {
    const result = await runScript(args);
    assert.equal(result.code, 0, `${args[0]}: ${result.stderr}`);
    assert.equal(JSON.parse(result.stdout).skipped, true);
    assert.match(result.stderr, /already cut over; skipping/);
  }
  assert.equal((await adapter.checkReadiness()).ready, true);
  console.log('PostgreSQL runtime regression passed: two-instance registration/read, route/trip CAS, nonce replay, POI refresh and deletion barrier');
} catch (error) {
  for (const instance of children) process.stderr.write(`[instance ${instance.label}] ${instance.logs.slice(-4000)}\n`);
  throw error;
} finally {
  await Promise.all(
    children.map(async ({ child }) => {
      if (child.exitCode == null) {
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        await exited;
      }
    })
  );
  await pool?.end();
  if (created) await run('dropdb', ['--host', postgresClientEnv.PGHOST, '--no-password', '--if-exists', database]);
  await rm(dataDir, { recursive: true, force: true });
}

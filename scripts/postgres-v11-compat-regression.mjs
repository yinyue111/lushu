// Rollback = swap the image only: the new code must run on a schema-v11 database (0012 never applied,
// or rolled back with the tables dropped). Builds a fresh v12 DB, drops everything 0012 added, marks it
// v11, then starts the app: the user app works, runtime config falls back to env, the admin console
// answers 503 ADMIN_SCHEMA_MISSING instead of crashing. Temporary local database only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPostgresAdapter } from '../server/postgresAdapter.mjs';
import { loadFilesystemStorageSnapshot } from '../server/storage/filesystemSnapshot.mjs';
import { applyPostgresMigrations } from '../server/storage/migrationRunner.mjs';
import { createPostgresPool } from '../server/storage/postgresConnection.mjs';
import { hermeticServerEnv } from './lib/hermetic-env.mjs';

const database = `lushu_v11_${process.pid}_${Date.now().toString(36)}`;
const dataDir = await mkdtemp(join(tmpdir(), 'lushu-pg-v11-'));
const profileSecret = 'postgres-v11-profile-secret';
const pgEnv = Object.fromEntries(['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD'].filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
if (!pgEnv.PGHOST) pgEnv.PGHOST = '/tmp';
let pool;
let child;
let created = false;

async function run(command, args) {
  const p = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  const [code] = await once(p, 'exit');
  if (code !== 0) throw new Error(`${command} exited ${code}: ${out}`);
}
async function freePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = /** @type {import('node:net').AddressInfo} */ (probe.address());
  await new Promise((r) => probe.close(r));
  return port;
}

try {
  await run('createdb', ['--host', pgEnv.PGHOST, '--no-password', '--template', 'template0', '--encoding', 'UTF8', database]);
  created = true;
  pool = createPostgresPool({ connectionString: '', environment: {}, host: pgEnv.PGHOST, database, applicationName: 'lushu-v11-compat' });
  await applyPostgresMigrations(pool);
  const adapter = createPostgresAdapter({ pool, profileIdSecret: profileSecret });
  const snapshot = await loadFilesystemStorageSnapshot(dataDir, { profileIdSecret: profileSecret });
  await adapter.replaceWithFilesystemSnapshot(snapshot);
  assert.equal((await adapter.compareFilesystemSnapshot(snapshot, { markReady: true })).matches, true);

  // Full rollback of 0012: the down file with its optional DROP statements enabled.
  const down = await readFile('server/migrations/down/0012_admin_config.down.sql', 'utf8');
  await pool.query(down.replace(/^-- ?/gm, '').replace(/^Rollback for 0012[\s\S]*?(?=update )/m, ''));
  const v = (await pool.query('select schema_version from trusted_routebook.storage_state')).rows[0].schema_version;
  assert.equal(Number(v), 11);
  assert.equal((await pool.query(`select to_regclass('trusted_routebook.admin_audit') as t`)).rows[0].t, null, 'admin tables are gone');
  assert.equal((await adapter.checkReadiness()).ready, true, 'v11 is a supported schema');

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let logs = '';
  child = spawn(process.execPath, ['server.mjs', '--production'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: hermeticServerEnv({
      STORAGE_BACKEND: 'postgres',
      ...pgEnv,
      PGDATABASE: database,
      POSTGRES_URL: '',
      DATABASE_URL: '',
      PROFILE_ID_SECRET: profileSecret,
      PROFILE_IDENTITY_ASSERTION_SECRET: 'postgres-v11-identity-secret',
      ROUTEBOOK_DATA_DIR: dataDir,
      HOST: '127.0.0.1',
      PORT: String(port),
      ADMIN_ENABLED: 'true',
      CONFIG_ENC_KEY: 'v11-compat-config-enc-key-0123456789',
      POSTGRES_POOL_MAX: '2'
    })
  });
  child.stdout.on('data', (d) => (logs += d));
  child.stderr.on('data', (d) => (logs += d));
  const get = async (path, init = {}) => {
    const r = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(10000), ...init });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  for (let i = 0; ; i += 1) {
    if (child.exitCode != null) throw new Error(`server exited on v11: ${logs}`);
    if ((await get('/api/live').catch(() => ({ status: 0 }))).status === 200) break;
    assert.ok(i < 150, `server never became live on v11: ${logs}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  // User app works.
  assert.equal((await get('/api/cities')).status, 200);
  const share = await get('/api/share/hangzhou-westlake-tea');
  assert.equal(share.status, 200, JSON.stringify(share.data));
  const registered = await get('/api/profile', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'p_v11_owner', pendingRegistrationSecret: `preg_${'c'.repeat(43)}`, creatorName: 'v11 测试' })
  });
  assert.equal(registered.status, 200, JSON.stringify(registered.data));
  const health = await get('/api/health');
  assert.equal(health.data.configVersion, 0, 'runtime config runs on env');
  // Admin console degrades with a clear error.
  const me = await get('/api/admin/me');
  assert.equal(me.status, 503, JSON.stringify(me.data));
  assert.equal(me.data.code, 'ADMIN_SCHEMA_MISSING');
  const login = await get('/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'x', password: 'y' }) });
  assert.equal(login.status, 503, JSON.stringify(login.data));
  assert.equal(child.exitCode, null, 'still running');
  console.log('PostgreSQL v11 compatibility passed: new code on schema 11 serves the user app; admin console reports ADMIN_SCHEMA_MISSING');
} finally {
  if (child && child.exitCode == null && child.signalCode == null) {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  }
  await pool?.end().catch(() => {});
  if (created) await run('dropdb', ['--host', pgEnv.PGHOST, '--no-password', '--if-exists', database]).catch(() => {});
  await rm(dataDir, { recursive: true, force: true });
}

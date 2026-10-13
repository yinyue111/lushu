// Runtime role vs owner, on an EXISTING v12 database built by a superuser owner (the production
// postgres:16 setup: POSTGRES_USER is superuser and owns every table). Adds the app role afterwards
// with scripts' ensureAppRole and checks: the app role can read/write rows and run the server, but
// cannot TRUNCATE / UPDATE / DELETE admin_audit, cannot disable its triggers, cannot set
// session_replication_role, and owns nothing. Needs an owner URL with CREATEDB + CREATEROLE:
//   ROLE_TEST_OWNER_URL=postgres://owner:pw@127.0.0.1:5432/postgres (CI: the service superuser).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPostgresAdapter } from '../server/postgresAdapter.mjs';
import { ensureAppRole } from '../server/storage/appRole.mjs';
import { loadFilesystemStorageSnapshot } from '../server/storage/filesystemSnapshot.mjs';
import { applyPostgresMigrations } from '../server/storage/migrationRunner.mjs';
import { createPostgresPool } from '../server/storage/postgresConnection.mjs';
import { hermeticServerEnv } from './lib/hermetic-env.mjs';

const ownerBase = process.env.ROLE_TEST_OWNER_URL || defaultOwnerUrl();
if (!ownerBase) {
  console.error('set ROLE_TEST_OWNER_URL (owner/superuser URL over TCP)');
  process.exit(1);
}
const suffix = `${process.pid}_${Date.now().toString(36)}`;
const database = `lushu_role_${suffix}`;
const role = `lushu_app_${suffix}`;
const rolePassword = `pw_${suffix}_x9`;
const profileSecret = 'app-role-profile-secret';
const dataDir = await mkdtemp(join(tmpdir(), 'lushu-pg-role-'));
const withDb = (url, db, user, password) => {
  const u = new URL(url);
  u.pathname = `/${db}`;
  if (user) u.username = user;
  if (password) u.password = password;
  return u.toString();
};
const ownerUrl = withDb(ownerBase, database);
const appUrl = withDb(ownerBase, database, role, rolePassword);
const admin = createPostgresPool({ connectionString: ownerBase, environment: {}, max: 1 });
let owner;
let app;
let child;
let created = false;

async function rejects(sql, pattern, label) {
  await assert.rejects(app.query(sql), pattern, label);
}

try {
  await admin.query(`create database ${database}`);
  created = true;
  owner = createPostgresPool({ connectionString: ownerUrl, environment: {}, max: 2 });
  const ownerInfo = (await owner.query('select current_user as u, (select rolsuper from pg_roles where rolname = current_user) as s')).rows[0];

  // 1. An existing v12 database, built and populated by the owner (as production is today).
  await applyPostgresMigrations(owner);
  const adapter = createPostgresAdapter({ pool: owner, profileIdSecret: profileSecret });
  const snapshot = await loadFilesystemStorageSnapshot(dataDir, { profileIdSecret: profileSecret });
  await adapter.replaceWithFilesystemSnapshot(snapshot);
  assert.equal((await adapter.compareFilesystemSnapshot(snapshot, { markReady: true })).matches, true);
  assert.equal(Number((await owner.query('select schema_version from trusted_routebook.storage_state')).rows[0].schema_version), 12);
  await owner.query(
    `insert into trusted_routebook.admin_audit (id, actor, role, action, target) values ('a1','owner','owner','seed',''), ('a2','owner','owner','seed','')`
  );

  // 2. Add the runtime role afterwards; twice, to prove it is idempotent.
  const first = await ensureAppRole(owner, { role, password: rolePassword });
  assert.equal(first.created, true);
  assert.equal((await ensureAppRole(owner, { role, password: rolePassword })).created, false);
  await assert.rejects(ensureAppRole(owner, { role: ownerInfo.u }), /must differ/);

  app = createPostgresPool({ connectionString: appUrl, environment: {}, max: 2 });
  const me = (await app.query('select current_user as u, rolsuper as s from pg_roles where rolname = current_user')).rows[0];
  assert.equal(me.u, role);
  assert.equal(me.s, false);
  const owned = await app.query(
    `select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'trusted_routebook' and pg_get_userbyid(c.relowner) = current_user`
  );
  assert.equal(owned.rows[0].n, 0, 'app role owns nothing');

  // 3. Rows: allowed. Audit: append only, even with the owner's tricks.
  assert.equal((await app.query('select count(*)::int as n from trusted_routebook.admin_audit')).rows[0].n, 2);
  await app.query(`insert into trusted_routebook.admin_audit (id, actor, role, action, target) values ('a3','app','app','x','')`);
  await rejects('truncate trusted_routebook.admin_audit', /permission denied|append-only/, 'truncate');
  await rejects(`update trusted_routebook.admin_audit set action = 'y'`, /permission denied|append-only/, 'update');
  await rejects('delete from trusted_routebook.admin_audit', /permission denied|append-only/, 'delete');
  await rejects('alter table trusted_routebook.admin_audit disable trigger admin_audit_no_truncate', /must be owner/, 'disable trigger');
  await rejects('alter table trusted_routebook.admin_audit disable trigger all', /must be owner/, 'disable all triggers');
  await rejects(`set session_replication_role = replica`, /permission denied/, 'replication role');
  await rejects('drop table trusted_routebook.admin_audit', /must be owner/, 'drop');
  await rejects('create table trusted_routebook.x (id int)', /permission denied/, 'create');
  await rejects(`delete from trusted_routebook.schema_migrations`, /permission denied/, 'migration bookkeeping');
  assert.equal((await owner.query('select count(*)::int as n from trusted_routebook.admin_audit')).rows[0].n, 3);

  // 4. The server runs as the app role (two connections: owner only for migrations).
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let logs = '';
  child = spawn(process.execPath, ['server.mjs', '--production'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: hermeticServerEnv({
      STORAGE_BACKEND: 'postgres',
      DATABASE_URL: appUrl,
      POSTGRES_URL: '',
      PROFILE_ID_SECRET: profileSecret,
      PROFILE_IDENTITY_ASSERTION_SECRET: 'app-role-identity-secret',
      ROUTEBOOK_DATA_DIR: dataDir,
      HOST: '127.0.0.1',
      PORT: String(port),
      ADMIN_ENABLED: 'true',
      CONFIG_ENC_KEY: 'app-role-config-enc-key-0123456789',
      POSTGRES_POOL_MAX: '2'
    })
  });
  child.stdout.on('data', (d) => (logs += d));
  child.stderr.on('data', (d) => (logs += d));
  const req = async (path, init = {}) => {
    const r = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(10000), ...init });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  for (let i = 0; ; i += 1) {
    if (child.exitCode != null) throw new Error(`server exited: ${logs}`);
    if ((await req('/api/live').catch(() => ({ status: 0 }))).status === 200) break;
    assert.ok(i < 150, `server never became live: ${logs}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal((await req('/api/ready')).status, 200);
  const registered = await req('/api/profile', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'p_role_owner', pendingRegistrationSecret: `preg_${'d'.repeat(43)}`, creatorName: '角色测试' })
  });
  assert.equal(registered.status, 200, JSON.stringify(registered.data));
  assert.equal((await req('/api/admin/me')).status, 401, 'admin console up (v12) under the app role');
  console.log(
    `PostgreSQL app role regression passed: existing v12 DB (owner ${ownerInfo.u}, superuser=${ownerInfo.s}) + app role ${role}: rows ok, audit truncate/update/delete/disable-trigger/replica refused, server runs`
  );
} finally {
  if (child && child.exitCode == null && child.signalCode == null) {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  }
  await app?.end().catch(() => {});
  await owner?.end().catch(() => {});
  if (created) await admin.query(`drop database if exists ${database} with (force)`).catch((e) => console.error(e.message));
  await admin.query(`drop role if exists ${role}`).catch((e) => console.error(e.message));
  await admin.end().catch(() => {});
  await rm(dataDir, { recursive: true, force: true });
}

function defaultOwnerUrl() {
  const { PGHOST, PGPORT = '5432', PGUSER, PGPASSWORD } = process.env;
  if (!PGHOST || PGHOST.startsWith('/') || !PGUSER || !PGPASSWORD) return '';
  return `postgres://${encodeURIComponent(PGUSER)}:${encodeURIComponent(PGPASSWORD)}@${PGHOST}:${PGPORT}/postgres`;
}

async function freePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = /** @type {import('node:net').AddressInfo} */ (probe.address());
  await new Promise((r) => probe.close(r));
  return port;
}

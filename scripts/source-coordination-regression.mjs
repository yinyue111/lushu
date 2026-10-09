import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  acquireJsonlRuntimeWriterLease,
  acquireSourceMigrationLease,
  inspectSourceCoordinationLease,
  sourceCoordinationPaths
} from '../server/storage/sourceCoordination.mjs';

const projectRoot = resolve(import.meta.dirname, '..');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'trusted-routebook-source-coordination-'));
const dataDir = join(temporaryRoot, 'data');
const databaseProbe = createDatabaseProbe();
let writerLease;
let migrationLease;

try {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await writeFile(join(dataDir, 'routebooks.jsonl'), '{invalid-json-that-must-not-be-read\n', { mode: 0o600 });
  const databaseUrl = await databaseProbe.listen();
  const scriptEnvironment = {
    PROFILE_ID_SECRET: 'source-coordination-regression-secret',
    ROUTEBOOK_ADMIN_TOKEN: 'must-not-be-used-as-profile-secret',
    ROUTEBOOK_API_TOKEN: 'must-not-be-used-as-profile-secret'
  };

  writerLease = await acquireJsonlRuntimeWriterLease({ dataDir, operation: 'regression-jsonl-writer' });
  assert.equal((await stat(writerLease.coordinationDir)).mode & 0o777, 0o700);
  assert.equal((await stat(writerLease.lockPath)).mode & 0o777, 0o600);
  await assert.rejects(
    () => acquireSourceMigrationLease({ dataDir, operation: 'regression-direct-migration' }),
    (/** @type {any} */ error) => error?.code === 'SOURCE_COORDINATION_LEASE_HELD' && error?.state === 'active'
  );

  const blockedBackfill = await runNodeScript(
    'scripts/postgres-backfill.mjs',
    ['--data-dir', dataDir, '--database-url', databaseUrl, '--apply'],
    scriptEnvironment
  );
  assert.equal(blockedBackfill.code, 1);
  assert.match(blockedBackfill.stderr, /SOURCE_COORDINATION_LEASE_HELD/);
  assert.doesNotMatch(blockedBackfill.stderr, /INVALID_JSONL_INPUT/);

  const blockedParity = await runNodeScript(
    'scripts/postgres-parity.mjs',
    ['--data-dir', dataDir, '--database-url', databaseUrl, '--mark-ready'],
    scriptEnvironment
  );
  assert.equal(blockedParity.code, 1);
  assert.match(blockedParity.stderr, /SOURCE_COORDINATION_LEASE_HELD/);
  assert.doesNotMatch(blockedParity.stderr, /INVALID_JSONL_INPUT/);
  assert.equal(databaseProbe.connections, 0, 'blocked migrations must not connect to PostgreSQL');

  await writerLease.release();
  writerLease = null;

  migrationLease = await acquireSourceMigrationLease({ dataDir, operation: 'regression-active-migration' });
  await assert.rejects(
    () => acquireJsonlRuntimeWriterLease({ dataDir, operation: 'regression-competing-jsonl-writer' }),
    (/** @type {any} */ error) => error?.code === 'SOURCE_COORDINATION_LEASE_HELD' && error?.state === 'active'
  );
  await migrationLease.release();
  migrationLease = null;

  const { coordinationDir, lockPath } = sourceCoordinationPaths(dataDir);
  await mkdir(coordinationDir, { recursive: true, mode: 0o700 });
  await writeLeaseFixture(lockPath, {
    token: '11111111111111111111111111111111',
    kind: 'runtime-writer',
    operation: 'dead-jsonl-writer',
    pid: 2_147_483_647,
    hostname: hostname()
  });
  assert.equal((await inspectSourceCoordinationLease(dataDir)).state, 'stale');
  migrationLease = await acquireSourceMigrationLease({ dataDir, operation: 'stale-lock-recovery' });
  const recovered = await inspectSourceCoordinationLease(dataDir);
  assert.equal(recovered.state, 'active');
  assert.equal(recovered.owner.operation, 'stale-lock-recovery');
  await migrationLease.release();
  migrationLease = null;

  await writeLeaseFixture(lockPath, {
    token: '22222222222222222222222222222222',
    kind: 'runtime-writer',
    operation: 'foreign-jsonl-writer',
    pid: process.pid,
    hostname: `${hostname()}-foreign`
  });
  await assert.rejects(
    () => acquireSourceMigrationLease({ dataDir, operation: 'foreign-lock-check' }),
    (/** @type {any} */ error) => error?.code === 'SOURCE_COORDINATION_LEASE_HELD' && error?.state === 'foreign-host'
  );
  await rm(lockPath, { force: true });

  await writeFile(lockPath, 'not-json\n', { mode: 0o600 });
  await assert.rejects(() => acquireSourceMigrationLease({ dataDir, operation: 'malformed-lock-check' }), { code: 'SOURCE_COORDINATION_LEASE_INVALID' });
  await rm(lockPath, { force: true });

  const missingSecretBackfill = await runNodeScript('scripts/postgres-backfill.mjs', ['--data-dir', dataDir, '--database-url', databaseUrl, '--apply'], {
    PROFILE_ID_SECRET: '',
    ROUTEBOOK_ADMIN_TOKEN: 'admin-fallback-must-be-rejected',
    ROUTEBOOK_API_TOKEN: 'api-fallback-must-be-rejected',
    NODE_ENV: 'development'
  });
  assert.equal(missingSecretBackfill.code, 1);
  assert.match(missingSecretBackfill.stderr, /PROFILE_ID_SECRET_REQUIRED_FOR_BACKFILL/);
  assert.equal(databaseProbe.connections, 0, 'missing-secret failure must happen before DB connection');

  await writeFile(join(dataDir, 'routebooks.jsonl'), `${JSON.stringify({ id: 'source-coordination-routebook', editToken: 'legacy_token_for_regression' })}\n`, {
    mode: 0o600
  });
  const dryRun = await runNodeScript('scripts/postgres-backfill.mjs', ['--data-dir', dataDir, '--database-url', databaseUrl], scriptEnvironment);
  assert.equal(dryRun.code, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /"applied": false/);
  assert.equal((await inspectSourceCoordinationLease(dataDir)).state, 'available');
  assert.equal(databaseProbe.connections, 0, 'dry-run backfill must not connect to PostgreSQL');

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      activeWriterRejected: true,
      activeMigrationRejectedWriter: true,
      staleLockRecovered: true,
      foreignHostFailClosed: true,
      malformedLeaseFailClosed: true,
      missingSecretRejectedBeforeDb: true,
      databaseConnections: databaseProbe.connections
    })}\n`
  );
} finally {
  await migrationLease?.release().catch(() => {});
  await writerLease?.release().catch(() => {});
  await databaseProbe.close();
  await rm(temporaryRoot, { recursive: true, force: true });
}

function writeLeaseFixture(filePath, owner) {
  return writeFile(
    filePath,
    `${JSON.stringify({
      version: 1,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      ...owner
    })}\n`,
    { mode: 0o600 }
  );
}

function runNodeScript(scriptPath, args, environment = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [join(projectRoot, scriptPath), ...args], {
      cwd: projectRoot,
      env: {
        ...process.env,
        ...environment,
        PROFILE_ID_SECRET: environment.PROFILE_ID_SECRET ?? process.env.PROFILE_ID_SECRET ?? ''
      },
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
    child.once('error', rejectRun);
    child.once('close', (code, signal) => resolveRun({ code, signal, stdout, stderr }));
  });
}

function createDatabaseProbe() {
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  return {
    get connections() {
      return connections;
    },
    async listen() {
      await new Promise((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(0, '127.0.0.1', () => resolveListen(undefined));
      });
      const address = /** @type {import('node:net').AddressInfo} */ (server.address());
      return `postgresql://probe:probe@127.0.0.1:${address.port}/probe`;
    },
    async close() {
      if (!server.listening) return;
      await new Promise((resolveClose) => server.close(resolveClose));
    }
  };
}

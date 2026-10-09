import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { renameSync } from 'node:fs';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { acquireSourceMigrationLease, recoverSourceCoordinationLease, sourceCoordinationPaths } from '../server/storage/sourceCoordination.mjs';

const projectRoot = resolve(import.meta.dirname, '..');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'trusted-routebook-lease-recovery-'));
const dataDir = join(temporaryRoot, 'data');
const localHostname = hostname().trim().toLowerCase();
const deadPid = 2_147_483_647;
const tokens = {
  stale: '11111111111111111111111111111111',
  wrong: '99999999999999999999999999999999',
  active: '22222222222222222222222222222222',
  renamedHost: '33333333333333333333333333333333',
  raceObserved: '44444444444444444444444444444444',
  raceReplacement: '55555555555555555555555555555555'
};

try {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const { coordinationDir, lockPath } = sourceCoordinationPaths(dataDir);
  await mkdir(coordinationDir, { recursive: true, mode: 0o700 });

  const availableInspection = await runLeaseCli(['inspect', '--data-dir', dataDir]);
  assert.equal(availableInspection.code, 0, availableInspection.stderr);
  const availableAudit = parseJson(availableInspection.stdout);
  assert.equal(availableAudit.ok, true);
  assert.equal(availableAudit.action, 'inspect');
  assert.equal(availableAudit.state, 'available');
  assert.equal(availableAudit.localHostname, localHostname);
  assert.match(availableAudit.inspectedAt, /^\d{4}-\d{2}-\d{2}T/);

  const staleCreatedAt = new Date(Date.now() - 120_000).toISOString();
  await writeLeaseFixture(lockPath, {
    token: tokens.stale,
    kind: 'runtime-writer',
    operation: 'stale-same-host-writer',
    pid: deadPid,
    hostname: localHostname,
    createdAt: staleCreatedAt
  });
  const staleInspection = parseJson((await runLeaseCli(['inspect', '--data-dir', dataDir])).stdout);
  assert.equal(staleInspection.state, 'stale');
  assert.equal(staleInspection.pidStatus, 'not-running');
  assert.equal(staleInspection.owner.hostname, localHostname);
  assert.equal(staleInspection.owner.pid, deadPid);
  assert.equal(staleInspection.owner.createdAt, staleCreatedAt);
  assert.ok(staleInspection.leaseAgeMs >= 120_000);
  assert.equal(staleInspection.automaticRecoveryAllowed, true);

  const unforcedStaleRecovery = await runLeaseCli(['recover', '--data-dir', dataDir, '--token', tokens.stale]);
  assert.equal(unforcedStaleRecovery.code, 1);
  const unforcedStaleAudit = parseJson(unforcedStaleRecovery.stderr);
  assert.equal(unforcedStaleAudit.code, 'SOURCE_COORDINATION_RECOVERY_FORCE_REQUIRED');
  assert.equal(unforcedStaleAudit.audit.inspection.state, 'stale');
  assert.equal(await leaseToken(lockPath), tokens.stale);

  const wrongTokenRecovery = await runLeaseCli(['recover', '--data-dir', dataDir, '--token', tokens.wrong, '--force']);
  assert.equal(wrongTokenRecovery.code, 1);
  assert.equal(parseJson(wrongTokenRecovery.stderr).code, 'SOURCE_COORDINATION_RECOVERY_TOKEN_MISMATCH');
  assert.equal(await leaseToken(lockPath), tokens.stale);

  const staleRecovery = await runLeaseCli(['recover', '--data-dir', dataDir, '--token', tokens.stale, '--force']);
  assert.equal(staleRecovery.code, 0, staleRecovery.stderr);
  const staleRecoveryAudit = parseJson(staleRecovery.stdout);
  assert.equal(staleRecoveryAudit.recovered, true);
  assert.equal(staleRecoveryAudit.forced, true);
  assert.equal(staleRecoveryAudit.reason, 'stale-local-lease-removed');
  assert.equal(staleRecoveryAudit.previousState, 'stale');
  assert.equal(staleRecoveryAudit.owner.pid, deadPid);
  await assert.rejects(() => access(lockPath), { code: 'ENOENT' });

  const idempotentRecovery = await runLeaseCli(['recover', '--data-dir', dataDir, '--token', tokens.stale, '--force']);
  assert.equal(idempotentRecovery.code, 0, idempotentRecovery.stderr);
  const idempotentAudit = parseJson(idempotentRecovery.stdout);
  assert.equal(idempotentAudit.recovered, false);
  assert.equal(idempotentAudit.reason, 'already-available');

  await writeLeaseFixture(lockPath, {
    token: tokens.active,
    kind: 'runtime-writer',
    operation: 'active-same-host-writer',
    pid: process.pid,
    hostname: localHostname
  });
  const activeInspection = parseJson((await runLeaseCli(['inspect', '--data-dir', dataDir])).stdout);
  assert.equal(activeInspection.state, 'active');
  assert.equal(activeInspection.pidStatus, 'running');
  assert.equal(activeInspection.forcedRecoveryAllowed, false);
  const activeRecovery = await runLeaseCli(['recover', '--data-dir', dataDir, '--token', tokens.active, '--force']);
  assert.equal(activeRecovery.code, 1);
  const activeRecoveryAudit = parseJson(activeRecovery.stderr);
  assert.equal(activeRecoveryAudit.code, 'SOURCE_COORDINATION_RECOVERY_ACTIVE');
  assert.equal(activeRecoveryAudit.audit.inspection.owner.pid, process.pid);
  assert.equal(await leaseToken(lockPath), tokens.active);
  await rm(lockPath, { force: true });

  const previousHostname = `${localHostname}-before-rename`;
  await writeLeaseFixture(lockPath, {
    token: tokens.renamedHost,
    kind: 'runtime-writer',
    operation: 'writer-before-machine-rename',
    pid: process.pid,
    hostname: previousHostname
  });
  const foreignInspection = parseJson((await runLeaseCli(['inspect', '--data-dir', dataDir])).stdout);
  assert.equal(foreignInspection.state, 'foreign-host');
  assert.equal(foreignInspection.owner.hostname, previousHostname);
  assert.equal(foreignInspection.owner.pid, process.pid);
  assert.equal(foreignInspection.pidStatus, 'unknown-foreign-host');
  assert.equal(foreignInspection.automaticRecoveryAllowed, false);
  assert.match(foreignInspection.warning, /cannot be verified locally/i);

  await assert.rejects(
    () => acquireSourceMigrationLease({ dataDir, operation: 'must-not-auto-delete-foreign-host' }),
    (/** @type {any} */ error) => error?.code === 'SOURCE_COORDINATION_LEASE_HELD' && error?.state === 'foreign-host'
  );
  assert.equal(await leaseToken(lockPath), tokens.renamedHost);

  const unforcedForeignRecovery = await runLeaseCli(['recover', '--data-dir', dataDir, '--token', tokens.renamedHost]);
  assert.equal(unforcedForeignRecovery.code, 1);
  assert.equal(parseJson(unforcedForeignRecovery.stderr).code, 'SOURCE_COORDINATION_RECOVERY_FORCE_REQUIRED');
  assert.equal(await leaseToken(lockPath), tokens.renamedHost);

  const foreignRecovery = await runLeaseCli(['recover', '--data-dir', dataDir, '--token', tokens.renamedHost, '--force']);
  assert.equal(foreignRecovery.code, 0, foreignRecovery.stderr);
  const foreignRecoveryAudit = parseJson(foreignRecovery.stdout);
  assert.equal(foreignRecoveryAudit.recovered, true);
  assert.equal(foreignRecoveryAudit.reason, 'forced-foreign-host-lease-removed');
  assert.equal(foreignRecoveryAudit.previousState, 'foreign-host');
  assert.equal(foreignRecoveryAudit.pidStatus, 'unknown-foreign-host');
  assert.match(foreignRecoveryAudit.warning, /original writer is stopped/i);
  await assert.rejects(() => access(lockPath), { code: 'ENOENT' });

  await writeLeaseFixture(lockPath, {
    token: tokens.raceObserved,
    kind: 'runtime-writer',
    operation: 'observed-stale-writer',
    pid: deadPid,
    hostname: localHostname
  });
  const replacementPath = join(coordinationDir, '.race-replacement');
  await writeLeaseFixture(replacementPath, {
    token: tokens.raceReplacement,
    kind: 'migration',
    operation: 'competing-active-migration',
    pid: process.pid,
    hostname: localHostname
  });
  let pidChecks = 0;
  await assert.rejects(
    () =>
      recoverSourceCoordinationLease(dataDir, {
        force: true,
        expectedToken: tokens.raceObserved,
        processKill(pid, signal) {
          pidChecks += 1;
          if (pidChecks === 1) {
            renameSync(replacementPath, lockPath);
            const error = /** @type {Error & Record<string, any>} */ (new Error(`PID ${pid} is not active`));
            error.code = 'ESRCH';
            throw error;
          }
          return process.kill(pid, signal);
        }
      }),
    (/** @type {any} */ error) =>
      error?.code === 'SOURCE_COORDINATION_RECOVERY_LEASE_CHANGED' &&
      error?.audit?.observedOwner?.token === tokens.raceObserved &&
      error?.audit?.inspection?.owner?.token === tokens.raceReplacement
  );
  assert.equal(await leaseToken(lockPath), tokens.raceReplacement);
  await rm(lockPath, { force: true });

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      sameHostStaleRecovered: true,
      forceAndTokenGatesEnforced: true,
      activePidProtected: true,
      foreignHostRequiresManualForce: true,
      competingReplacementProtected: true,
      recoveryIsIdempotent: true
    })}\n`
  );
} finally {
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

async function leaseToken(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8')).token;
}

function parseJson(value) {
  return JSON.parse(String(value).trim());
}

function runLeaseCli(args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [join(projectRoot, 'scripts/source-lease.mjs'), ...args], {
      cwd: projectRoot,
      env: { ...process.env },
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

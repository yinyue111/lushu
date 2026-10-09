import { constants as fsConstants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, open, rm, unlink } from 'node:fs/promises';
import { hostname as readHostname } from 'node:os';
import { join, resolve } from 'node:path';

const LEASE_VERSION = 1;
export const SOURCE_COORDINATION_DIRECTORY_NAME = '.source-coordination';
const ACTIVE_LEASE_FILE_NAME = 'active.lease';
const MAX_ACQUIRE_ATTEMPTS = 4;
const LEASE_TOKEN_PATTERN = /^[0-9a-f-]{16,64}$/i;
const FOREIGN_HOST_RECOVERY_WARNING =
  'The lease owner is on a different hostname, so its PID cannot be verified locally. Confirm that the original writer is stopped before forced recovery.';

export async function acquireJsonlRuntimeWriterLease(options = {}) {
  return acquireSourceLease({
    ...options,
    kind: 'runtime-writer',
    operation: options.operation || 'jsonl-runtime'
  });
}

export async function acquireSourceMigrationLease(options = {}) {
  return acquireSourceLease({
    ...options,
    kind: 'migration',
    operation: options.operation || 'postgres-migration'
  });
}

export function sourceCoordinationPaths(dataDir) {
  const root = resolveRequiredDataDir(dataDir);
  const coordinationDir = join(root, SOURCE_COORDINATION_DIRECTORY_NAME);
  return {
    dataDir: root,
    coordinationDir,
    lockPath: join(coordinationDir, ACTIVE_LEASE_FILE_NAME)
  };
}

export async function inspectSourceCoordinationLease(dataDir, options = {}) {
  const paths = sourceCoordinationPaths(dataDir);
  const inspectedAt = inspectionTimestamp(options.now);
  const localHostname = normalizeHostname(options.hostname ?? readHostname());
  if (!localHostname) {
    throw coordinationError('SOURCE_COORDINATION_HOSTNAME_REQUIRED', 'A local hostname is required to inspect the source coordination lease.');
  }
  const coordinationDirectoryExists = await assertSafeExistingCoordinationDirectory(paths.coordinationDir);
  if (!coordinationDirectoryExists) {
    return leaseInspection(paths, {
      state: 'available',
      owner: null,
      inspectedAt,
      localHostname,
      leaseAgeMs: null,
      pidStatus: 'not-applicable',
      automaticRecoveryAllowed: false,
      forcedRecoveryAllowed: false,
      warning: null
    });
  }
  const owner = await readLeaseOwner(paths.lockPath).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!owner) {
    return leaseInspection(paths, {
      state: 'available',
      owner: null,
      inspectedAt,
      localHostname,
      leaseAgeMs: null,
      pidStatus: 'not-applicable',
      automaticRecoveryAllowed: false,
      forcedRecoveryAllowed: false,
      warning: null
    });
  }

  const leaseAgeMs = Math.max(0, Date.parse(inspectedAt) - Date.parse(owner.createdAt));
  if (owner.hostname !== localHostname) {
    return leaseInspection(paths, {
      state: 'foreign-host',
      owner,
      inspectedAt,
      localHostname,
      leaseAgeMs,
      pidStatus: 'unknown-foreign-host',
      automaticRecoveryAllowed: false,
      forcedRecoveryAllowed: true,
      warning: FOREIGN_HOST_RECOVERY_WARNING
    });
  }
  const active = isProcessActive(owner.pid, options.processKill);
  return leaseInspection(paths, {
    state: active ? 'active' : 'stale',
    owner,
    inspectedAt,
    localHostname,
    leaseAgeMs,
    pidStatus: active ? 'running' : 'not-running',
    automaticRecoveryAllowed: !active,
    forcedRecoveryAllowed: !active,
    warning: active ? 'The local lease owner PID is active. Stop the writer cleanly; forced recovery is not allowed.' : null
  });
}

export async function recoverSourceCoordinationLease(dataDir, options = {}) {
  const force = options.force === true;
  const expectedToken = String(options.expectedToken ?? options.token ?? '').trim();
  const inspectionOptions = {
    hostname: options.hostname,
    processKill: options.processKill,
    now: options.now
  };
  const observed = await inspectSourceCoordinationLease(dataDir, inspectionOptions);

  if (!force) {
    throw recoveryError(
      'SOURCE_COORDINATION_RECOVERY_FORCE_REQUIRED',
      'Recovery is a destructive operator action and requires force=true (CLI: --force).',
      observed,
      { force, expectedToken, reason: 'force-required' }
    );
  }
  if (!expectedToken) {
    throw recoveryError(
      'SOURCE_COORDINATION_RECOVERY_TOKEN_REQUIRED',
      'Recovery requires the exact lease token returned by inspect (CLI: --token <token>).',
      observed,
      { force, expectedToken: null, reason: 'token-required' }
    );
  }
  if (!LEASE_TOKEN_PATTERN.test(expectedToken)) {
    throw recoveryError('SOURCE_COORDINATION_RECOVERY_TOKEN_INVALID', 'The expected source coordination lease token is invalid.', observed, {
      force,
      expectedToken,
      reason: 'token-invalid'
    });
  }
  if (observed.state === 'available') {
    return recoveryResult(observed, {
      recovered: false,
      force,
      expectedToken,
      reason: 'already-available'
    });
  }
  if (observed.owner.token !== expectedToken) {
    throw recoveryError(
      'SOURCE_COORDINATION_RECOVERY_TOKEN_MISMATCH',
      'The expected token does not match the inspected source coordination lease; it was left untouched.',
      observed,
      { force, expectedToken, reason: 'token-mismatch' }
    );
  }
  if (observed.state === 'active') {
    throw recoveryError(
      'SOURCE_COORDINATION_RECOVERY_ACTIVE',
      `Source coordination lease PID ${observed.owner.pid} is active on ${observed.owner.hostname}; it was left untouched.`,
      observed,
      { force, expectedToken, reason: 'active-local-pid' }
    );
  }

  const confirmed = await inspectSourceCoordinationLease(dataDir, {
    ...inspectionOptions,
    now: undefined
  });
  if (confirmed.state === 'available') {
    return recoveryResult(observed, {
      recovered: false,
      force,
      expectedToken,
      reason: 'lease-already-absent',
      confirmedAt: confirmed.inspectedAt
    });
  }
  if (confirmed.owner.token !== expectedToken || !sameLeaseOwner(confirmed.owner, observed.owner)) {
    throw recoveryError(
      'SOURCE_COORDINATION_RECOVERY_LEASE_CHANGED',
      'The source coordination lease changed after inspection; the replacement lease was left untouched.',
      confirmed,
      {
        force,
        expectedToken,
        reason: 'lease-changed',
        observedOwner: { ...observed.owner },
        observedAt: observed.inspectedAt
      }
    );
  }
  if (confirmed.state === 'active') {
    throw recoveryError(
      'SOURCE_COORDINATION_RECOVERY_ACTIVE',
      `Source coordination lease PID ${confirmed.owner.pid} became active on ${confirmed.owner.hostname}; it was left untouched.`,
      confirmed,
      { force, expectedToken, reason: 'active-local-pid' }
    );
  }

  try {
    await unlink(confirmed.lockPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return recoveryResult(observed, {
      recovered: false,
      force,
      expectedToken,
      reason: 'lease-already-absent',
      confirmedAt: confirmed.inspectedAt
    });
  }
  return recoveryResult(confirmed, {
    recovered: true,
    force,
    expectedToken,
    reason: confirmed.state === 'foreign-host' ? 'forced-foreign-host-lease-removed' : 'stale-local-lease-removed',
    confirmedAt: confirmed.inspectedAt
  });
}

/** @param {{dataDir?: string, kind?: string, operation?: string, pid?: number, hostname?: string, processKill?: typeof process.kill}} [options] */
async function acquireSourceLease({ dataDir, kind, operation, pid = process.pid, hostname = readHostname(), processKill } = {}) {
  const paths = sourceCoordinationPaths(dataDir);
  const owner = normalizeOwner({
    version: LEASE_VERSION,
    token: randomUUID(),
    kind,
    operation,
    pid,
    hostname,
    createdAt: new Date().toISOString()
  });

  await mkdir(paths.dataDir, { recursive: true, mode: 0o700 });
  await chmod(paths.dataDir, 0o700);
  await ensurePrivateCoordinationDirectory(paths.coordinationDir);

  const candidatePath = join(paths.coordinationDir, `.candidate-${owner.token}`);
  await writeLeaseCandidate(candidatePath, owner);
  try {
    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
      try {
        await link(candidatePath, paths.lockPath);
        return createLeaseHandle(paths, owner);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }

      const observed = await inspectSourceCoordinationLease(paths.dataDir, {
        hostname: owner.hostname,
        processKill
      });
      if (observed.state === 'available') continue;
      if (observed.state !== 'stale') throw leaseHeldError(observed, owner);

      const current = await readLeaseOwner(paths.lockPath).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!current) continue;
      if (!sameLeaseOwner(current, observed.owner)) continue;
      await unlink(paths.lockPath).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
    throw coordinationError('SOURCE_COORDINATION_ACQUIRE_RACE', `Could not acquire the source coordination lease after ${MAX_ACQUIRE_ATTEMPTS} attempts.`);
  } finally {
    await rm(candidatePath, { force: true }).catch(() => {});
  }
}

function createLeaseHandle(paths, owner) {
  let released = false;
  return {
    ...paths,
    owner: { ...owner },
    async release() {
      if (released) return false;
      const current = await readLeaseOwner(paths.lockPath).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!current || !sameLeaseOwner(current, owner)) {
        throw coordinationError(
          'SOURCE_COORDINATION_LEASE_OWNERSHIP_LOST',
          'The source coordination lease changed before it could be released; it was left untouched.'
        );
      }
      await unlink(paths.lockPath);
      released = true;
      return true;
    }
  };
}

async function ensurePrivateCoordinationDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw coordinationError('SOURCE_COORDINATION_PATH_UNSAFE', `Source coordination path must be a real directory: ${directory}`);
  }
  await chmod(directory, 0o700);
}

async function assertSafeExistingCoordinationDirectory(directory) {
  let info;
  try {
    info = await lstat(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw coordinationError('SOURCE_COORDINATION_PATH_UNSAFE', `Source coordination path must be a real directory: ${directory}`);
  }
  return true;
}

async function writeLeaseCandidate(filePath, owner) {
  const handle = await open(filePath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(filePath, 0o600);
}

async function readLeaseOwner(filePath) {
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw coordinationError('SOURCE_COORDINATION_LEASE_INVALID', `Source coordination lease is not a regular file: ${filePath}`);
  }
  let raw;
  try {
    const noFollow = Number(fsConstants.O_NOFOLLOW || 0);
    const handle = await open(filePath, fsConstants.O_RDONLY | noFollow);
    try {
      raw = await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code === 'ELOOP') {
      throw coordinationError('SOURCE_COORDINATION_LEASE_INVALID', `Source coordination lease cannot be a symbolic link: ${filePath}`);
    }
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw coordinationError('SOURCE_COORDINATION_LEASE_INVALID', `Source coordination lease metadata is invalid JSON: ${filePath}`);
  }
  return normalizeOwner(parsed);
}

function normalizeOwner(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw coordinationError('SOURCE_COORDINATION_LEASE_INVALID', 'Source coordination lease owner is invalid.');
  }
  const version = Number(value.version);
  const token = String(value.token ?? '').trim();
  const kind = String(value.kind ?? '').trim();
  const operation = String(value.operation ?? '').trim();
  const pid = Number(value.pid);
  const hostname = normalizeHostname(value.hostname);
  const createdAt = String(value.createdAt ?? '').trim();
  if (
    version !== LEASE_VERSION ||
    !LEASE_TOKEN_PATTERN.test(token) ||
    !['runtime-writer', 'migration'].includes(kind) ||
    !operation ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    !hostname ||
    !createdAt ||
    !Number.isFinite(Date.parse(createdAt))
  ) {
    throw coordinationError('SOURCE_COORDINATION_LEASE_INVALID', 'Source coordination lease metadata is invalid.');
  }
  return { version, token, kind, operation, pid, hostname, createdAt };
}

function leaseInspection(paths, details) {
  return {
    state: details.state,
    owner: details.owner ? { ...details.owner } : null,
    inspectedAt: details.inspectedAt,
    localHostname: details.localHostname,
    leaseAgeMs: details.leaseAgeMs,
    pidStatus: details.pidStatus,
    automaticRecoveryAllowed: details.automaticRecoveryAllowed,
    forcedRecoveryAllowed: details.forcedRecoveryAllowed,
    warning: details.warning,
    ...paths
  };
}

function recoveryResult(inspection, { recovered, force, expectedToken, reason, confirmedAt = inspection.inspectedAt }) {
  return {
    action: 'recover',
    recovered,
    forced: force,
    expectedToken,
    reason,
    requestedAt: inspection.inspectedAt,
    confirmedAt,
    completedAt: new Date().toISOString(),
    previousState: inspection.state,
    state: 'available',
    owner: inspection.owner ? { ...inspection.owner } : null,
    localHostname: inspection.localHostname,
    leaseAgeMs: inspection.leaseAgeMs,
    pidStatus: inspection.pidStatus,
    warning: inspection.warning,
    dataDir: inspection.dataDir,
    coordinationDir: inspection.coordinationDir,
    lockPath: inspection.lockPath
  };
}

function recoveryError(code, message, inspection, details = {}) {
  const error = coordinationError(code, message);
  error.state = inspection.state;
  error.owner = inspection.owner ? { ...inspection.owner } : null;
  error.audit = {
    action: 'recover',
    recovered: false,
    auditedAt: new Date().toISOString(),
    ...details,
    inspection
  };
  return error;
}

function inspectionTimestamp(value) {
  const milliseconds = value === undefined ? Date.now() : value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(milliseconds)) {
    throw coordinationError('SOURCE_COORDINATION_INSPECTION_TIME_INVALID', 'Source coordination inspection time must be a finite Unix timestamp or Date.');
  }
  return new Date(milliseconds).toISOString();
}

function isProcessActive(pid, processKill = process.kill.bind(process)) {
  try {
    processKill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw coordinationError('SOURCE_COORDINATION_PID_CHECK_FAILED', `Could not determine whether source coordination owner PID ${pid} is active.`);
  }
}

function sameLeaseOwner(left, right) {
  return (
    left?.version === right?.version &&
    left?.token === right?.token &&
    left?.kind === right?.kind &&
    left?.operation === right?.operation &&
    left?.pid === right?.pid &&
    left?.hostname === right?.hostname &&
    left?.createdAt === right?.createdAt
  );
}

function leaseHeldError(observed, requestedOwner) {
  const owner = observed.owner;
  const location = observed.state === 'foreign-host' ? `foreign host ${owner.hostname}` : `local PID ${owner.pid}`;
  const error = coordinationError(
    'SOURCE_COORDINATION_LEASE_HELD',
    `Cannot start ${requestedOwner.operation}: ${owner.operation} holds the source lease on ${location}. Stop the JSONL writer before migration; inspect foreign-host leases and use explicit token-matched forced recovery only after confirming the original writer is stopped.`
  );
  error.state = observed.state;
  error.owner = { ...owner };
  return error;
}

function resolveRequiredDataDir(value) {
  const dataDir = String(value ?? '').trim();
  if (!dataDir) {
    throw coordinationError('SOURCE_COORDINATION_DATA_DIR_REQUIRED', 'A dataDir is required for source coordination.');
  }
  return resolve(dataDir);
}

function normalizeHostname(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

function coordinationError(code, message) {
  const error = /** @type {Error & Record<string, any>} */ (new Error(message));
  error.code = code;
  return error;
}

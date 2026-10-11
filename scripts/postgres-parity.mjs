import { resolve } from 'node:path';
import { createPostgresAdapter } from '../server/postgresAdapter.mjs';
import { loadFilesystemStorageSnapshot } from '../server/storage/filesystemSnapshot.mjs';
import { redactPostgresError } from '../server/storage/postgresConnection.mjs';
import { acquireSourceMigrationLease } from '../server/storage/sourceCoordination.mjs';

let adapter;
let migrationLease;
try {
  const options = parseArgs(process.argv.slice(2));
  const dataDir = options.dataDir || resolve('data');
  const profileIdSecret = requireExplicitProfileIdSecret();
  migrationLease = await acquireSourceMigrationLease({
    dataDir,
    operation: options.markReady ? 'postgres-parity-mark-ready' : 'postgres-parity-check'
  });

  const snapshot = await loadFilesystemStorageSnapshot(dataDir, { profileIdSecret });
  adapter = createPostgresAdapter({
    connectionString: options.databaseUrl,
    applicationName: 'trusted-routebook-parity',
    max: 1,
    profileIdSecret
  });
  if (options.markReady && (await adapter.isCutOver())) {
    // Already cut over (upgrade re-run): live data has moved on from the old files, nothing to mark.
    process.stderr.write('PostgreSQL is already cut over; skipping parity --mark-ready (nothing to do).\n');
    process.stdout.write(`${JSON.stringify({ ok: true, skipped: true, reason: 'already-cut-over' }, null, 2)}\n`);
  } else {
    const comparison = await adapter.compareFilesystemSnapshot(snapshot, { markReady: options.markReady });
    process.stdout.write(`${JSON.stringify({ ok: comparison.matches, ...comparison }, null, 2)}\n`);
    if (!comparison.matches) process.exitCode = 1;
  }
} catch (error) {
  const comparison = error.comparison;
  if (comparison) {
    process.stdout.write(`${JSON.stringify({ ok: false, ...comparison, markedReady: false }, null, 2)}\n`);
  }
  process.stderr.write(`PostgreSQL parity failed [${error?.code ?? 'PARITY_FAILED'}]: ${redactPostgresError(error.message)}\n`);
  process.exitCode = 1;
} finally {
  await adapter?.close().catch(() => {});
  await migrationLease?.release().catch((error) => {
    process.stderr.write(`PostgreSQL parity lease release failed [${error?.code ?? 'LEASE_RELEASE_FAILED'}]: ${error.message}\n`);
    process.exitCode = 1;
  });
}

function parseArgs(args) {
  const output = { markReady: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--database-url') output.databaseUrl = requireValue(args, ++index, arg);
    else if (arg === '--data-dir') output.dataDir = resolve(requireValue(args, ++index, arg));
    else if (arg === '--mark-ready') output.markReady = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return output;
}

function requireValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function requireExplicitProfileIdSecret() {
  const secret = String(process.env.PROFILE_ID_SECRET ?? '').trim();
  if (secret) return secret;
  const error = /** @type {Error & Record<string, any>} */ (
    new Error(
      'Set an explicit non-empty PROFILE_ID_SECRET before PostgreSQL parity. API/admin token fallbacks and the local development default are not accepted.'
    )
  );
  error.code = 'PROFILE_ID_SECRET_REQUIRED_FOR_PARITY';
  throw error;
}

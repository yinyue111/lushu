import { resolve } from 'node:path';
import { createPostgresAdapter } from '../server/postgresAdapter.mjs';
import { loadFilesystemStorageSnapshot } from '../server/storage/filesystemSnapshot.mjs';
import { redactPostgresError } from '../server/storage/postgresConnection.mjs';
import { assertRoutebookSnapshotCredentialsSanitized } from '../server/storage/routebookCredentials.mjs';
import { acquireSourceMigrationLease } from '../server/storage/sourceCoordination.mjs';

let adapter;
let migrationLease;
try {
  const options = parseArgs(process.argv.slice(2));
  const dataDir = options.dataDir || resolve('data');
  const profileIdSecret = requireExplicitProfileIdSecret();
  migrationLease = await acquireSourceMigrationLease({
    dataDir,
    operation: options.apply ? 'postgres-backfill-apply' : 'postgres-backfill-dry-run'
  });

  const snapshot = await loadFilesystemStorageSnapshot(dataDir, { profileIdSecret });
  snapshot.streams.routebooks.rows.forEach((row) => assertRoutebookSnapshotCredentialsSanitized(row));
  const summary = {
    manifestSha256: snapshot.manifestSha256,
    rows: Object.values(snapshot.streams).reduce((sum, entry) => sum + entry.count, 0),
    configs: Object.values(snapshot.configs).filter((entry) => entry.present).length,
    streams: Object.fromEntries(Object.entries(snapshot.streams).map(([name, entry]) => [name, entry.count]))
  };

  if (!options.apply) {
    process.stdout.write(`${JSON.stringify({ ok: true, applied: false, ...summary }, null, 2)}\n`);
  } else {
    adapter = createPostgresAdapter({
      connectionString: options.databaseUrl,
      applicationName: 'trusted-routebook-backfill',
      max: 1,
      profileIdSecret
    });
    // Upgrades re-run the one-shot migrate service: a database already cut over must not be backfilled
    // again (that would be destructive), so this step is a no-op instead of an error.
    if (await adapter.isCutOver()) {
      process.stderr.write('PostgreSQL is already cut over; skipping backfill (nothing to do).\n');
      process.stdout.write(`${JSON.stringify({ ok: true, skipped: true, reason: 'already-cut-over' }, null, 2)}\n`);
    } else {
      const result = await adapter.replaceWithFilesystemSnapshot(snapshot, { force: options.force });
      process.stdout.write(`${JSON.stringify({ ok: true, applied: true, ...summary, ...result }, null, 2)}\n`);
    }
  }
} catch (error) {
  process.stderr.write(`PostgreSQL backfill failed [${error?.code ?? 'BACKFILL_FAILED'}]: ${redactPostgresError(error.message)}\n`);
  process.exitCode = 1;
} finally {
  await adapter?.close().catch(() => {});
  await migrationLease?.release().catch((error) => {
    process.stderr.write(`PostgreSQL backfill lease release failed [${error?.code ?? 'LEASE_RELEASE_FAILED'}]: ${error.message}\n`);
    process.exitCode = 1;
  });
}

function parseArgs(args) {
  const output = { apply: false, force: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--database-url') output.databaseUrl = requireValue(args, ++index, arg);
    else if (arg === '--data-dir') output.dataDir = resolve(requireValue(args, ++index, arg));
    else if (arg === '--apply') output.apply = true;
    else if (arg === '--force') output.force = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (output.force && !output.apply) throw new Error('--force is only valid with --apply');
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
      'Set an explicit non-empty PROFILE_ID_SECRET before reading or applying a PostgreSQL backfill. API/admin token fallbacks and the local development default are not accepted.'
    )
  );
  error.code = 'PROFILE_ID_SECRET_REQUIRED_FOR_BACKFILL';
  throw error;
}

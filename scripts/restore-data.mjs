import { resolve } from 'node:path';
import { acquireSourceMigrationLease } from '../server/storage/sourceCoordination.mjs';
import { readAndVerifyBackup, requireBackupKey, restoreVerifiedBackup } from './lib/backupArchive.mjs';

let sourceLease;
try {
  const options = parseArgs(process.argv.slice(2));
  if (!options.input) throw new Error('--input is required');
  const verified = await readAndVerifyBackup({
    inputPath: options.input,
    encryptionKey: requireBackupKey()
  });

  if (!options.apply) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          verified: true,
          applied: false,
          path: verified.path,
          createdAt: verified.createdAt,
          fileCount: verified.fileCount,
          totalBytes: verified.totalBytes,
          manifestSha256: verified.manifestSha256
        },
        null,
        2
      )}\n`
    );
  } else {
    const dataDir = resolve(options.dataDir || 'data');
    sourceLease = await acquireSourceMigrationLease({ dataDir, operation: 'encrypted-restore-apply' });
    const result = await restoreVerifiedBackup({
      verified,
      dataDir,
      force: options.force
    });
    process.stdout.write(`${JSON.stringify({ ok: true, verified: true, applied: true, ...result }, null, 2)}\n`);
  }
} catch (error) {
  process.stderr.write(`Encrypted restore failed [${error?.code ?? 'RESTORE_FAILED'}]: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  await sourceLease?.release().catch((error) => {
    process.stderr.write(`Encrypted restore lease release failed [${error?.code ?? 'LEASE_RELEASE_FAILED'}]: ${error.message}\n`);
    process.exitCode = 1;
  });
}

function parseArgs(args) {
  const output = { apply: false, force: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--input') output.input = requireValue(args, ++index, arg);
    else if (arg === '--data-dir') output.dataDir = requireValue(args, ++index, arg);
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

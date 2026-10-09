import { resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { acquireSourceMigrationLease } from '../server/storage/sourceCoordination.mjs';
import { createEncryptedBackup, requireBackupKey } from './lib/backupArchive.mjs';

let sourceLease;
try {
  const options = parseArgs(process.argv.slice(2));
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dataDir = resolve(options.dataDir || 'data');
  const encryptionKey = requireBackupKey();
  await assertSourceDataDirectory(dataDir);
  sourceLease = await acquireSourceMigrationLease({ dataDir, operation: 'encrypted-backup' });
  const result = await createEncryptedBackup({
    dataDir,
    outputPath: options.output || resolve('backups', `trusted-routebook-${timestamp}.trbk`),
    encryptionKey
  });
  process.stdout.write(`${JSON.stringify({ ok: true, encrypted: true, ...result }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`Encrypted backup failed [${error?.code ?? 'BACKUP_FAILED'}]: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  await sourceLease?.release().catch((error) => {
    process.stderr.write(`Encrypted backup lease release failed [${error?.code ?? 'LEASE_RELEASE_FAILED'}]: ${error.message}\n`);
    process.exitCode = 1;
  });
}

function parseArgs(args) {
  const output = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--data-dir') output.dataDir = requireValue(args, ++index, arg);
    else if (arg === '--output') output.output = requireValue(args, ++index, arg);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return output;
}

function requireValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

async function assertSourceDataDirectory(dataDir) {
  let info;
  try {
    info = await stat(dataDir);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!info?.isDirectory()) throw new Error(`data directory does not exist: ${dataDir}`);
}

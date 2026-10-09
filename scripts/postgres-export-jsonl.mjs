import { resolve } from 'node:path';
import { createPostgresAdapter } from '../server/postgresAdapter.mjs';
import { exportStorageSnapshotToJsonl } from '../server/storage/filesystemSnapshot.mjs';
import { redactPostgresError } from '../server/storage/postgresConnection.mjs';

const options = parseArgs(process.argv.slice(2));
if (!options.outputDir) throw new Error('--output-dir is required');
const adapter = createPostgresAdapter({
  connectionString: options.databaseUrl,
  applicationName: 'trusted-routebook-jsonl-export',
  max: 1
});

try {
  const snapshot = await adapter.loadStorageSnapshot({ allowNotReady: true });
  const result = await exportStorageSnapshotToJsonl(snapshot, options.outputDir, { force: options.force });
  process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`PostgreSQL JSONL export failed: ${redactPostgresError(error.message)}\n`);
  process.exitCode = 1;
} finally {
  await adapter.close().catch(() => {});
}

function parseArgs(args) {
  const output = { force: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--database-url') output.databaseUrl = requireValue(args, ++index, arg);
    else if (arg === '--output-dir') output.outputDir = resolve(requireValue(args, ++index, arg));
    else if (arg === '--force') output.force = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return output;
}

function requireValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

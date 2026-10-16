import { resolve } from 'node:path';
import { BACKUP_RETENTION_DAYS, pruneBackups } from './lib/backupRetention.mjs';

try {
  const args = process.argv.slice(2);
  let dir = resolve('backups');
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--dir' && args[index + 1] && !args[index + 1].startsWith('--')) dir = resolve(args[++index]);
    else if (args[index] === '--dry-run') dryRun = true;
    else throw new Error(`unknown argument: ${args[index]}`);
  }
  const result = await pruneBackups({ dir, dryRun });
  process.stdout.write(`${JSON.stringify({ ok: true, dir, retentionDays: BACKUP_RETENTION_DAYS, dryRun, ...result }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`Backup prune failed: ${error.message}\n`);
  process.exitCode = 1;
}

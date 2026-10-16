import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

// Privacy policy promises: copies in operational backups are kept at most one month (30 days).
export const BACKUP_RETENTION_DAYS = 30;
const BACKUP_FILE = /^trusted-routebook-.+\.trbk$/;

// Deletes encrypted backups produced by `npm run backup:data` whose mtime is older than the retention window.
// Only touches files matching the backup naming scheme; anything else in the directory is left alone.
/**
 * @param {{ dir: string, maxAgeDays?: number, now?: number, dryRun?: boolean }} options
 */
export async function pruneBackups({ dir, maxAgeDays = BACKUP_RETENTION_DAYS, now = Date.now(), dryRun = false }) {
  if (!dir) throw new Error('backup directory is required');
  if (!(Number(maxAgeDays) > 0)) throw new Error('maxAgeDays must be positive');
  const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
  let names;
  try {
    names = await readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return { removed: [], kept: [] };
    throw error;
  }
  const removed = [];
  const kept = [];
  for (const name of names.sort()) {
    if (!BACKUP_FILE.test(name)) continue;
    const path = join(dir, name);
    const info = await stat(path);
    if (!info.isFile()) continue;
    if (info.mtimeMs < cutoff) {
      if (!dryRun) await rm(path, { force: true });
      removed.push(name);
    } else kept.push(name);
  }
  return { removed, kept };
}

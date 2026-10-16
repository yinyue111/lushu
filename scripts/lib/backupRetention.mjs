import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

// Privacy policy promises: copies in operational backups are kept at most 30 days.
export const BACKUP_RETENTION_DAYS = 30;
const BACKUP_FILE = /^trusted-routebook-(.+)\.trbk$/;

// backup-data.mjs names files trusted-routebook-<ISO with ':' and '.' replaced by '-'>.trbk,
// e.g. trusted-routebook-2026-10-16T00-05-00-123Z.trbk. Returns epoch ms, or NaN if unparseable.
export function backupTimestampFromName(name) {
  const match = BACKUP_FILE.exec(name);
  const ts = match && /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-(\d{1,3}))?Z$/.exec(match[1]);
  if (!ts) return Number.NaN;
  const iso = `${ts[1]}T${ts[2]}:${ts[3]}:${ts[4]}.${(ts[5] ?? '0').padEnd(3, '0')}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && new Date(ms).toISOString() === iso ? ms : Number.NaN;
}

// Deletes encrypted backups produced by `npm run backup:data` whose filename date is older than the
// retention window. The date comes from the filename, not mtime (copies/restores reset mtime).
// Files whose date cannot be parsed are skipped with a warning. A missing directory is an error.
/**
 * @param {{ dir: string, maxAgeDays?: number, now?: number, dryRun?: boolean, warn?: (message: string) => void }} options
 */
export async function pruneBackups({ dir, maxAgeDays = BACKUP_RETENTION_DAYS, now = Date.now(), dryRun = false, warn = (m) => console.warn(m) }) {
  if (!dir) throw new Error('backup directory is required');
  if (!(Number(maxAgeDays) > 0)) throw new Error('maxAgeDays must be positive');
  const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
  let names;
  try {
    names = await readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`backup directory does not exist: ${dir}`);
    throw error;
  }
  const removed = [];
  const kept = [];
  const skipped = [];
  for (const name of names.sort()) {
    if (!BACKUP_FILE.test(name)) continue;
    const path = join(dir, name);
    if (!(await stat(path)).isFile()) continue;
    const createdAt = backupTimestampFromName(name);
    if (!Number.isFinite(createdAt)) {
      warn(`[backup:prune] skipped ${name}: cannot parse date from filename`);
      skipped.push(name);
      continue;
    }
    if (createdAt < cutoff) {
      if (!dryRun) await rm(path, { force: true });
      removed.push(name);
    } else kept.push(name);
  }
  return { removed, kept, skipped };
}

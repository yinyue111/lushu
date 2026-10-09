// Append-only JSONL storage primitives: append + hooks, reverse scans, row cache.
// This is the storage seam: a database backend would replace these readers/writers.
import { appendFile, mkdir, stat, open, readFile, writeFile, rename, rm, chmod } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { DATA_DIR, PROFILE_LOG_PATH, PROFILE_LIFECYCLE_LOG_PATH, ROUTEBOOK_LOG_PATH, PROFILE_ID_SECRET } from '../config/index.mjs';
import { eventStreamNameForPath } from './contract.mjs';
import { usesPostgresStorage, getPostgresStorage, withStorageEntityLock } from './runtime.mjs';
import { sanitizeRoutebookSnapshotCredentials } from './routebookCredentials.mjs';

const JSONL_SCAN_CHUNK_BYTES = 256 * 1024;
const JSONL_NEWLINE_BYTE = 0x0a;
const JSONL_EMPTY_BUFFER = Buffer.alloc(0);

// Per-file hooks run after a successful append (derived caches, version maps).
const jsonlAppendHooks = new Map();

export function onJsonlAppend(filePath, hook) {
  if (!jsonlAppendHooks.has(filePath)) jsonlAppendHooks.set(filePath, []);
  jsonlAppendHooks.get(filePath).push(hook);
}

let profileWriteGuard;
export function registerProfileWriteGuard(guard) {
  profileWriteGuard = guard;
}

export async function appendJsonLine(filePath, payload, { profileMutationLocked = false, expectedVersion = undefined } = {}) {
  const ownerId = String(payload?.profileId ?? 'anonymous');
  if (!profileMutationLocked && profileWriteGuard && ownerId !== 'anonymous' && ownerId && ![PROFILE_LOG_PATH, PROFILE_LIFECYCLE_LOG_PATH].includes(filePath)) {
    return profileWriteGuard(ownerId, () => appendJsonLine(filePath, payload, { profileMutationLocked: true, expectedVersion }));
  }
  const persisted = filePath === ROUTEBOOK_LOG_PATH ? sanitizeRoutebookSnapshotCredentials(payload, { profileIdSecret: PROFILE_ID_SECRET }) : payload;
  if (usesPostgresStorage()) {
    if (filePath === ROUTEBOOK_LOG_PATH && expectedVersion !== undefined) await getPostgresStorage().appendVersionedRoutebook(persisted, { expectedVersion });
    else await getPostgresStorage().appendJsonLine(eventStreamNameForPath(filePath), persisted);
  } else {
    await withStorageEntityLock('file', filePath, async () => {
      await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
      await appendFile(filePath, `${JSON.stringify(persisted)}\n`, { encoding: 'utf8', mode: 0o600 });
      await chmod(filePath, 0o600);
    });
  }
  // rank23 读放大治理：写后主动失效对应文件的行缓存/派生缓存。
  invalidateJsonlRowsCache(filePath);
  for (const hook of jsonlAppendHooks.get(filePath) ?? []) await hook(persisted);
}

export async function rewriteJsonlExcluding(filePath, predicate, _options = {}) {
  return rewriteRows(filePath, (row) => (predicate(row) ? null : row), true);
}

export async function rewriteJsonlRows(filePath, transform, _options = {}) {
  return rewriteRows(filePath, transform, false);
}

async function rewriteRows(filePath, transform, exclude) {
  let changed;
  if (usesPostgresStorage()) {
    const adapter = getPostgresStorage();
    changed = exclude
      ? await adapter.rewriteJsonlExcluding(eventStreamNameForPath(filePath), (row) => transform(row) === null)
      : await adapter.rewriteJsonlRows(eventStreamNameForPath(filePath), transform);
  } else {
    changed = await withStorageEntityLock('file', filePath, async () => {
      let raw;
      try {
        raw = await readFile(filePath, 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') return 0;
        throw error;
      }
      let count = 0;
      const retained = [];
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        let row;
        try {
          row = JSON.parse(line);
        } catch {
          retained.push(line);
          continue;
        }
        const next = transform(row);
        if (exclude && next === null) {
          count++;
          continue;
        }
        const serialized = JSON.stringify(next);
        retained.push(serialized);
        if (serialized !== line.trim()) count++;
      }
      if (!count) return 0;
      const temporary = `${filePath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, retained.length ? `${retained.join('\n')}\n` : '', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        await rename(temporary, filePath);
      } finally {
        await rm(temporary, { force: true });
      }
      return count;
    });
  }
  if (changed) {
    invalidateJsonlRowsCache(filePath);
    for (const hook of jsonlAppendHooks.get(filePath) ?? []) await hook(null);
  }
  return changed;
}

// rank23②：(path, mtimeMs, size) 键的进程级 JSONL 尾窗行缓存（LRU，上限 32 个文件）。
// 缓存按「最新在前」的已解析行数组存放；同一文件指纹下重复读直接命中，
// appendJsonLine 落盘后主动失效；外部写入靠指纹变化兜底失效。
// 除条目数外还按估算字符总量（原始 JSONL 行长求和）设约 6400 万字符的
// 内存上限，超出按 LRU 逐出，防止大 JSONL 常驻缓存拖向 OOM。
const JSONL_ROWS_CACHE_MAX_ENTRIES = 32;
const JSONL_ROWS_CACHE_MAX_TOTAL_CHARS = 64_000_000;
const jsonlRowsCache = new Map();
// H5: a single scan larger than this share of the budget is returned but not
// cached, so one oversized file cannot evict every other entry and stay resident.
const JSONL_ROWS_CACHE_MAX_ENTRY_CHARS = Math.floor(JSONL_ROWS_CACHE_MAX_TOTAL_CHARS / 2);

function jsonlRowsCacheKey(filePath, projection) {
  return projection ? `${filePath}#${projection.name}` : filePath;
}

function evictJsonlRowsCacheOverBudget() {
  while (jsonlRowsCache.size > JSONL_ROWS_CACHE_MAX_ENTRIES) {
    jsonlRowsCache.delete(jsonlRowsCache.keys().next().value);
  }
  let totalChars = 0;
  for (const entry of jsonlRowsCache.values()) totalChars += entry.approxChars ?? 0;
  while (totalChars > JSONL_ROWS_CACHE_MAX_TOTAL_CHARS && jsonlRowsCache.size > 0) {
    const oldestKey = jsonlRowsCache.keys().next().value;
    totalChars -= jsonlRowsCache.get(oldestKey)?.approxChars ?? 0;
    jsonlRowsCache.delete(oldestKey);
  }
}

function invalidateJsonlRowsCache(filePath) {
  for (const key of [...jsonlRowsCache.keys()]) {
    if (key === filePath || key.startsWith(`${filePath}#`)) jsonlRowsCache.delete(key);
  }
}

export async function jsonlFileFingerprint(filePath) {
  if (usesPostgresStorage()) return getPostgresStorage().streamFingerprint(eventStreamNameForPath(filePath));
  try {
    const stats = await stat(filePath);
    return `${stats.mtimeMs}:${stats.size}`;
  } catch {
    return 'missing';
  }
}

async function scanRecentJsonlRows(filePath, maxRows, projection = null) {
  const project = projection?.project ?? null;
  const handle = await open(filePath, 'r');
  const rows = [];
  let pending = JSONL_EMPTY_BUFFER;
  let complete = false;
  // 估算字符量（原始行长求和），供行缓存做内存预算。
  let approxChars = 0;
  try {
    const { size } = await handle.stat();
    if (!size) return { rows, complete: true, approxChars };
    let position = size;
    while (position > 0 && rows.length < maxRows) {
      const bytesToRead = Math.min(JSONL_SCAN_CHUNK_BYTES, position);
      position -= bytesToRead;
      const buffer = Buffer.alloc(bytesToRead);
      await handle.read(buffer, 0, bytesToRead, position);
      const { head, lines } = splitTrailingJsonlLines(pending.length ? Buffer.concat([buffer, pending]) : buffer);
      pending = head;
      for (let index = lines.length - 1; index >= 0 && rows.length < maxRows; index -= 1) {
        const line = lines[index].trim();
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          if (project) {
            const projected = project(parsed);
            rows.push(projected);
            approxChars += projected && typeof projected === 'object' ? JSON.stringify(projected).length : line.length;
          } else {
            rows.push(parsed);
            approxChars += line.length;
          }
        } catch {
          // Skip corrupted historical JSONL rows.
        }
      }
    }
    if (position <= 0 && rows.length < maxRows) {
      const firstLine = pending.toString('utf8').trim();
      if (firstLine) {
        try {
          const parsed = JSON.parse(firstLine);
          const projected = project ? project(parsed) : parsed;
          rows.push(projected);
          approxChars += project && projected && typeof projected === 'object' ? JSON.stringify(projected).length : firstLine.length;
        } catch {
          // Skip corrupted historical JSONL rows.
        }
      }
      complete = true;
    }
    return { rows, complete, approxChars };
  } finally {
    await handle.close();
  }
}

export async function readRecentJsonlRows(filePath, maxRows, projection = null) {
  if (usesPostgresStorage()) {
    const rows = await getPostgresStorage().readJsonLines(eventStreamNameForPath(filePath), maxRows);
    return projection?.project ? rows.map(projection.project) : rows;
  }
  if (!existsSync(filePath)) return [];
  const safeMaxRows = Number.isFinite(maxRows) && maxRows > 0 ? Math.floor(maxRows) : Number.MAX_SAFE_INTEGER;
  const cacheKey = jsonlRowsCacheKey(filePath, projection);
  const fingerprint = await jsonlFileFingerprint(filePath);
  const cached = jsonlRowsCache.get(cacheKey);
  if (cached && cached.fingerprint === fingerprint && (cached.complete || cached.rows.length >= safeMaxRows)) {
    // LRU touch。
    jsonlRowsCache.delete(cacheKey);
    jsonlRowsCache.set(cacheKey, cached);
    return cached.rows;
  }
  const { rows, complete, approxChars } = await scanRecentJsonlRows(filePath, safeMaxRows, projection);
  jsonlRowsCache.delete(cacheKey);
  if (approxChars <= JSONL_ROWS_CACHE_MAX_ENTRY_CHARS) {
    jsonlRowsCache.set(cacheKey, { fingerprint, rows, complete, approxChars });
    evictJsonlRowsCacheOverBudget();
  }
  return rows;
}

export async function withSingleProcessKeyLock(lockMap, key, operation) {
  const predecessor = lockMap.get(key);
  /** @type {(value?: unknown) => void} */
  let release;
  const gate = new Promise((resolveGate) => {
    release = resolveGate;
  });
  lockMap.set(key, gate);
  if (predecessor) await predecessor;
  try {
    return await operation();
  } finally {
    release();
    if (lockMap.get(key) === gate) lockMap.delete(key);
  }
}

export async function readJsonLines(filePath, limit = 50) {
  if (usesPostgresStorage()) return getPostgresStorage().readJsonLines(eventStreamNameForPath(filePath), limit);
  if (!existsSync(filePath)) return [];
  const safeLimit = Math.max(1, Number.isFinite(Number(limit)) ? Number(limit) : 50);
  const rows = await readRecentJsonlRows(filePath, safeLimit);
  return rows.slice(0, safeLimit);
}

// Reverse scans keep the incomplete leading fragment as bytes, not as a decoded
// string: a chunk boundary inside a multi-byte character would otherwise decode
// to U+FFFD on both sides and silently corrupt that row's Chinese text.
function splitTrailingJsonlLines(buffer) {
  const boundary = buffer.indexOf(JSONL_NEWLINE_BYTE);
  if (boundary === -1) return { head: buffer, lines: [] };
  const lines = [];
  let cursor = boundary + 1;
  while (cursor < buffer.length) {
    const next = buffer.indexOf(JSONL_NEWLINE_BYTE, cursor);
    if (next === -1) {
      lines.push(buffer.subarray(cursor).toString('utf8'));
      break;
    }
    lines.push(buffer.subarray(cursor, next).toString('utf8'));
    cursor = next + 1;
  }
  return { head: buffer.subarray(0, boundary), lines };
}

export async function findLatestJsonLine(filePath, predicate, scanLimit = 50000) {
  if (usesPostgresStorage()) return getPostgresStorage().findLatestJsonLine(eventStreamNameForPath(filePath), predicate, scanLimit);
  if (!existsSync(filePath)) return null;
  const handle = await open(filePath, 'r');
  let pending = JSONL_EMPTY_BUFFER;
  let scanned = 0;
  try {
    const { size } = await handle.stat();
    if (!size) return null;
    let position = size;
    while (position > 0 && scanned < scanLimit) {
      const bytesToRead = Math.min(JSONL_SCAN_CHUNK_BYTES, position);
      position -= bytesToRead;
      const buffer = Buffer.alloc(bytesToRead);
      await handle.read(buffer, 0, bytesToRead, position);
      const { head, lines } = splitTrailingJsonlLines(pending.length ? Buffer.concat([buffer, pending]) : buffer);
      pending = head;
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index].trim();
        if (!line) continue;
        scanned += 1;
        try {
          const row = JSON.parse(line);
          if (predicate(row)) return row;
        } catch {
          // Skip corrupted historical JSONL rows.
        }
        if (scanned >= scanLimit) break;
      }
    }
    const firstLine = pending.toString('utf8').trim();
    if (firstLine && scanned < scanLimit) {
      try {
        const row = JSON.parse(firstLine);
        if (predicate(row)) return row;
      } catch {
        // Skip corrupted historical JSONL rows.
      }
    }
    return null;
  } finally {
    await handle.close();
  }
}

// Reverse-scans for the latest row per key. H4: `predicate` is evaluated on the
// latest row of each key *during* the scan, so filtered lists return up to `limit`
// matches instead of filtering an already-truncated global window (which made
// older routebooks of a city/profile disappear). A key whose latest row does not
// match is excluded even if an older version would have matched.
export async function readLatestUniqueJsonLines(filePath, keyFn, limit = 100, scanLimit = 50000, predicate = null) {
  if (usesPostgresStorage()) return getPostgresStorage().readLatestUniqueJsonLines(eventStreamNameForPath(filePath), keyFn, limit, scanLimit, predicate);
  if (!existsSync(filePath)) return [];
  const safeLimit = Math.max(1, Number.isFinite(Number(limit)) ? Number(limit) : 100);
  const handle = await open(filePath, 'r');
  const latestByKey = new Map();
  const seenKeys = new Set();
  let pending = JSONL_EMPTY_BUFFER;
  let scanned = 0;
  const consider = (row) => {
    const key = keyFn(row);
    if (!key || seenKeys.has(key)) return;
    seenKeys.add(key);
    if (!predicate || predicate(row)) latestByKey.set(key, row);
  };
  try {
    const { size } = await handle.stat();
    if (!size) return [];
    let position = size;
    while (position > 0 && scanned < scanLimit && latestByKey.size < safeLimit) {
      const bytesToRead = Math.min(JSONL_SCAN_CHUNK_BYTES, position);
      position -= bytesToRead;
      const buffer = Buffer.alloc(bytesToRead);
      await handle.read(buffer, 0, bytesToRead, position);
      const { head, lines } = splitTrailingJsonlLines(pending.length ? Buffer.concat([buffer, pending]) : buffer);
      pending = head;
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index].trim();
        if (!line) continue;
        scanned += 1;
        try {
          consider(JSON.parse(line));
        } catch {
          // Skip corrupted historical JSONL rows.
        }
        if (scanned >= scanLimit || latestByKey.size >= safeLimit) break;
      }
    }
    const firstLine = pending.toString('utf8').trim();
    if (firstLine && scanned < scanLimit && latestByKey.size < safeLimit) {
      try {
        consider(JSON.parse(firstLine));
      } catch {
        // Skip corrupted historical JSONL rows.
      }
    }
    return [...latestByKey.values()].slice(0, safeLimit);
  } finally {
    await handle.close();
  }
}

// 先物化 scanLimit 行的尾窗（走 readRecentJsonlRows 行缓存），再在内存中按
// 谓词过滤凑满 limit 条。窗口远大于旧「全局尾窗 + filter」路径，避免热门
// 租户把其他 profile/route 的历史行挤出统计；返回顺序与 readJsonLines 一致
// （最新在前），保证各处「首个命中即最新」的去重语义不变。
export async function readMatchingJsonLines(filePath, predicate, limit = 50, scanLimit = 50000, projection = null) {
  if (usesPostgresStorage()) {
    const rows = await getPostgresStorage().readMatchingJsonLines(eventStreamNameForPath(filePath), predicate, limit, scanLimit);
    return projection?.project ? rows.map(projection.project) : rows;
  }
  if (!existsSync(filePath)) return [];
  const safeLimit = Math.max(1, Number.isFinite(Number(limit)) ? Number(limit) : 50);
  const safeScanLimit = Number.isFinite(scanLimit) && scanLimit > 0 ? Math.floor(scanLimit) : 50000;
  const rows = await readRecentJsonlRows(filePath, safeScanLimit, projection);
  return collectMatchingRows(rows, predicate, safeLimit, safeScanLimit);
}

export function collectMatchingRows(rows, predicate, limit, scanLimit = Number.MAX_SAFE_INTEGER) {
  const matches = [];
  let scanned = 0;
  for (const row of rows ?? []) {
    scanned += 1;
    if (predicate(row)) {
      matches.push(row);
      if (matches.length >= limit) break;
    }
    if (scanned >= scanLimit) break;
  }
  return matches;
}

// Backend-neutral "latest row for key" lookups.
//
// PostgreSQL: event_rows.entity_key / expression indexes (migration 0006),
// one index probe + LIMIT 1 per lookup.
// JSONL: an incrementally maintained offset index (jsonl-index.mjs) for the
// streams listed in JSONL_INDEXED_STREAMS; other streams keep the reverse scan
// so very high-cardinality logs (exposures, check-ins) do not hold an offset map
// for every row in memory.
import { createJsonlKeyIndex } from './jsonl-index.mjs';
import { eventStreamNameForPath } from './contract.mjs';
import { entityKeyFunctionForStream, secondaryKeyFunction } from './entityKeys.mjs';
import { findLatestJsonLine } from './jsonl.mjs';
import { getPostgresStorage, usesPostgresStorage } from './runtime.mjs';

const JSONL_INDEXED_STREAMS = new Set(['routebooks', 'reviews', 'profiles', 'poi-corrections', 'identity-nonces', 'trip-sessions', 'checkin-photos']);
const indexes = new Map();

function indexFor(filePath, cacheKey, keyFn) {
  const id = `${filePath}\u0000${cacheKey}`;
  if (!indexes.has(id)) indexes.set(id, createJsonlKeyIndex({ filePath, keyFn }));
  return indexes.get(id);
}

/** Shared JSONL entity index for `filePath` (also used by records.mjs). */
export function entityKeyIndexFor(filePath) {
  const stream = eventStreamNameForPath(filePath);
  const keyFn = entityKeyFunctionForStream(stream);
  if (!keyFn) throw new Error(`Stream ${stream} has no entity key`);
  return indexFor(filePath, 'entity', keyFn);
}

export async function findLatestByEntityKey(filePath, key) {
  const rawKey = String(key ?? '');
  if (!rawKey) return null;
  const stream = eventStreamNameForPath(filePath);
  const keyFn = entityKeyFunctionForStream(stream);
  if (!keyFn) throw new Error(`Stream ${stream} has no entity key`);
  if (usesPostgresStorage()) return getPostgresStorage().findLatestByEntityKey(stream, rawKey);
  if (JSONL_INDEXED_STREAMS.has(stream)) return entityKeyIndexFor(filePath).get(rawKey);
  return findLatestJsonLine(filePath, (row) => keyFn(row) === rawKey, Number.POSITIVE_INFINITY);
}

export async function findLatestBySecondaryKey(filePath, field, value) {
  const expected = String(value ?? '');
  if (!expected) return null;
  const stream = eventStreamNameForPath(filePath);
  const keyFn = secondaryKeyFunction(stream, field);
  if (!keyFn) throw new Error(`Stream ${stream} has no secondary key ${field}`);
  if (usesPostgresStorage()) return getPostgresStorage().findLatestBySecondaryKey(stream, field, expected);
  return indexFor(filePath, `secondary:${field}`, keyFn).get(expected);
}

/** Test/maintenance hook: drop all JSONL offset indexes (e.g. after a rewrite). */
export function resetKeyedLookupIndexes() {
  for (const index of indexes.values()) index.reset();
}

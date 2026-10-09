// Entity keys: the single definition of "which entity does this row belong to"
// for each append-only stream. Both backends use it:
//   - JSONL: in-memory offset indexes (jsonl-index.mjs) key rows with it.
//   - PostgreSQL: every inserted row stores it in event_rows.entity_key
//     (migration 0006) so "latest row for id X" is an index probe + LIMIT 1
//     instead of reading and hashing the whole stream.
//
// Contract for event_rows.entity_key:
//   NULL  = not computed yet (rows written before 0006 or by an older binary);
//           readers must still evaluate these rows in JS, so lookups stay
//           correct before/while the backfill runs.
//   ''    = computed, the row has no entity key (or the stream is not keyed).
//   other = the encoded key (see encodeEntityKey).
//
// Changing a key function changes the meaning of stored keys: ship a migration
// that resets entity_key to NULL for that stream so the backfill recomputes it.
import { createHash } from 'node:crypto';
import { sanitizePublicId } from '../lib/util.mjs';

const MAX_RAW_KEY_LENGTH = 200;

const stringField = (field) => (row) => (typeof row?.[field] === 'string' ? row[field] : '');

export function publicIdEntityKey(row) {
  return sanitizePublicId(row?.id || row?.publicId);
}

export function profileEntityKey(row) {
  const id = sanitizePublicId(row?.id || row?.profileId);
  return id && id !== 'anonymous' ? id : '';
}

export function idEntityKey(row) {
  return sanitizePublicId(row?.id);
}

export function exposureEntityKey(row) {
  return String(row?.exposureId ?? row?.id ?? '');
}

/** stream name → key function. Streams not listed store '' (unkeyed). */
export const STREAM_ENTITY_KEYS = Object.freeze({
  routebooks: publicIdEntityKey,
  reviews: publicIdEntityKey,
  profiles: profileEntityKey,
  'poi-corrections': idEntityKey,
  checkins: idEntityKey,
  'identity-nonces': stringField('key'),
  'trip-sessions': stringField('sessionKey'),
  'checkin-photos': stringField('id'),
  exposures: exposureEntityKey
});

/**
 * Secondary equality lookups served by dedicated PostgreSQL expression indexes
 * (and lazily built JSONL offset indexes). field name → key function.
 */
export const STREAM_SECONDARY_KEYS = Object.freeze({
  profiles: Object.freeze({ registrationCredentialHash: stringField('registrationCredentialHash') })
});

export function entityKeyFunctionForStream(stream) {
  return STREAM_ENTITY_KEYS[stream] ?? null;
}

export function secondaryKeyFunction(stream, field) {
  return STREAM_SECONDARY_KEYS[stream]?.[field] ?? null;
}

/** Bounded, deterministic storage form of a raw key (btree-safe length). */
export function encodeEntityKey(rawKey) {
  const key = String(rawKey ?? '');
  if (!key) return '';
  if (key.length <= MAX_RAW_KEY_LENGTH) return key;
  return `sha256:${createHash('sha256').update(key).digest('hex')}`;
}

/** Value written to event_rows.entity_key for a payload in `stream`. */
export function storedEntityKey(stream, payload) {
  const keyFn = entityKeyFunctionForStream(stream);
  if (!keyFn) return '';
  try {
    return encodeEntityKey(keyFn(payload));
  } catch {
    return '';
  }
}

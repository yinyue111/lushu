// Routebook listing.
import { sanitizePublicId } from '../lib/util.mjs';
import { ROUTEBOOK_LOG_PATH } from '../config/index.mjs';
import { readLatestUniqueJsonLines } from '../storage/jsonl.mjs';

// `predicate` filters on the latest snapshot of each routebook while scanning (H4).
export async function listSavedRoutebooks(limit = 100, predicate = null) {
  return readLatestUniqueJsonLines(
    ROUTEBOOK_LOG_PATH,
    (row) => sanitizePublicId(row?.id || row?.publicId),
    limit,
    50000,
    (row) => !row?.tombstone && !row?.deletedAt && (!predicate || predicate(row))
  );
}

// Routebook listing.
import { ROUTEBOOK_LOG_PATH } from '../config/index.mjs';
import { readLatestUniqueJsonLines } from '../storage/jsonl.mjs';
import { publicIdEntityKey } from '../storage/entityKeys.mjs';

// `predicate` filters on the latest snapshot of each routebook while scanning (H4).
// Passing the stream's canonical entity key function lets the PostgreSQL backend
// serve this from the (stream, entity_key, ordinal) index instead of a full read.
export async function listSavedRoutebooks(limit = 100, predicate = null) {
  return readLatestUniqueJsonLines(
    ROUTEBOOK_LOG_PATH,
    publicIdEntityKey,
    limit,
    50000,
    (row) => !row?.tombstone && !row?.deletedAt && (!predicate || predicate(row))
  );
}

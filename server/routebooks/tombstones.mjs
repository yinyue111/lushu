// Deleted routebooks stay deleted. A delete appends a content-free tombstone row (owner profile + id);
// every later write of that id — from any device, any client version — is refused with 410
// ROUTEBOOK_DELETED so clients can drop their local copy instead of re-uploading it.
import { createHttpError, sanitizePublicId } from '../lib/util.mjs';
import { getSavedRoutebook } from '../storage/records.mjs';

export const isDeletedRoutebook = (row) => Boolean(row?.tombstone || row?.deletedAt);

export function routebookDeletedError(id, row) {
  const error = createHttpError('这份路书已经删除了，打不开，也不能再保存', 410, 'ROUTEBOOK_DELETED');
  /** @type {any} */ (error).details = { id, deletedAt: row?.deletedAt ?? null };
  return error;
}

/** Throws 410 when the latest stored row for this id is a tombstone. */
export async function assertRoutebookNotDeleted(publicId) {
  const id = sanitizePublicId(publicId);
  if (!id) return;
  const latest = await getSavedRoutebook(id);
  if (isDeletedRoutebook(latest)) throw routebookDeletedError(id, latest);
}

/** Which of these ids are deleted (tombstoned). Unknown ids are not reported. */
export async function deletedRoutebookIds(ids) {
  const out = [];
  for (const raw of ids) {
    const id = sanitizePublicId(raw);
    if (id && isDeletedRoutebook(await getSavedRoutebook(id))) out.push(id);
  }
  return out;
}

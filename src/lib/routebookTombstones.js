// A routebook deleted from the account (on any device) must not linger or be re-uploaded from
// another device. The server answers 410 ROUTEBOOK_DELETED for such ids; this drops the local copy.
import { deleteRoutebook, getStoredRoutebookById } from './storage.js';

export const ROUTEBOOK_DELETED_EVENT = 'lushu:routebook-deleted';

/** Removes every local copy stored under this id. @returns {boolean} whether anything was removed */
export function dropDeletedLocalCopy(id) {
  const key = String(id ?? '');
  if (!key) return false;
  let removed = false;
  for (let i = 0; i < 5 && getStoredRoutebookById(key); i += 1) removed = deleteRoutebook(key) || removed;
  return removed;
}

/** Ids worth asking about: local copies that ever reached the cloud. */
export function cloudIdsOf(books) {
  return [
    ...new Set(
      (books ?? [])
        .filter((book) => book?.publicId || Number(book?.version) > 0)
        .map((book) => String(book.publicId || book.id || ''))
        .filter(Boolean)
    )
  ].slice(0, 300);
}

/**
 * Asks the server which local copies were deleted and drops them.
 * @param {any[]} books
 * @param {(ids: string[]) => Promise<{ deleted?: string[] }>} check
 * @returns {Promise<string[]>} removed ids
 */
export async function pruneDeletedLocalRoutebooks(books, check) {
  const ids = cloudIdsOf(books);
  if (!ids.length) return [];
  const { deleted = [] } = await check(ids);
  return deleted.filter((id) => dropDeletedLocalCopy(id));
}

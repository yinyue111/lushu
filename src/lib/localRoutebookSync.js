// Guest "保存副本并出发" copies (and other drafts) made before cloud sync was enabled live
// only in localStorage (version 0). Once the profile has a cloud token they are uploaded;
// on a conflict the cloud copy wins as the main routebook and the local edits are kept as
// a 冲突副本 (which itself uploads on the next pass).

/** @param {Record<string, any> | null | undefined} book */
export function isLocalOnlyRoutebook(book) {
  const version = Number(book?.version);
  return (
    Boolean(book?.city) &&
    Array.isArray(book?.stops) &&
    book.stops.length >= 2 &&
    (book?.publishStatus || 'draft') === 'draft' &&
    !(Number.isInteger(version) && version > 0) &&
    !book?.cloudSyncBlocked
  );
}

/**
 * @typedef {{
 *   profile: Record<string, any>,
 *   books: Record<string, any>[],
 *   profileFields: (profile: Record<string, any>) => Record<string, any>,
 *   save: (book: Record<string, any>) => Promise<{ routebook: Record<string, any> }>,
 *   fetchRemote: (id: string) => Promise<{ routebook: Record<string, any> }>,
 *   persist: (book: Record<string, any>) => boolean,
 *   preserveConflict: (book: Record<string, any>, label: string) => { saved: boolean, draft: Record<string, any> | null }
 * }} SyncDeps
 */

/**
 * @param {SyncDeps} deps
 * @returns {Promise<{ uploaded: string[], conflicts: string[], failed: string[], deleted: string[], skipped?: string }>}
 */
export async function uploadLocalOnlyRoutebooks({ profile, books, profileFields, save, fetchRemote, persist, preserveConflict }) {
  /** @type {{ uploaded: string[], conflicts: string[], failed: string[], deleted: string[], skipped?: string }} */
  const result = { uploaded: [], conflicts: [], failed: [], deleted: [] };
  if (!(profile?.profileAccessToken || profile?.accountUserId)) return { ...result, skipped: 'cloud-sync-disabled' };
  for (const book of books.filter(isLocalOnlyRoutebook)) {
    const id = String(book.publicId || book.id || '');
    const local = { ...book, ...profileFields(profile) };
    /** @param {Record<string, any>} remote */
    const adopt = (remote) =>
      persist({ ...local, ...remote, ...profileFields(profile), editToken: remote.editToken || local.editToken, publishStatus: 'draft' });
    try {
      const data = await save({ ...local, expectedVersion: 0 });
      adopt(data.routebook);
      result.uploaded.push(id);
    } catch (error) {
      const status = /** @type {any} */ (error)?.status;
      if (status === 410 || /** @type {any} */ (error)?.code === 'ROUTEBOOK_DELETED') {
        // Deleted from the account: never re-upload, never keep a 冲突副本. The caller drops the local copy.
        result.deleted.push(id);
      } else if (status === 409) {
        // The same id already reached the cloud (another tab/device, or a lost response).
        const remote = await fetchRemote(id)
          .then((data) => data?.routebook ?? null)
          .catch(() => null);
        const remoteTime = Date.parse(String(remote?.updatedAt ?? ''));
        const localTime = Date.parse(String(book.updatedAt ?? book.provider?.editedAt ?? ''));
        if (remote && !(localTime > remoteTime)) {
          // Cloud is newer (or same age): keep it, and keep the local edits as a 冲突副本.
          adopt(remote);
          preserveConflict(book, '云端同步冲突');
          result.conflicts.push(id);
        } else if (remote) {
          try {
            const data = await save({ ...local, expectedVersion: Number(remote.version) || 0 });
            adopt(data.routebook);
            result.uploaded.push(id);
          } catch {
            preserveConflict(book, '云端同步冲突');
            result.conflicts.push(id);
          }
        } else {
          preserveConflict(book, '云端同步冲突');
          persist({ ...book, cloudSyncBlocked: true });
          result.conflicts.push(id);
        }
      } else if (status === 403) {
        // The id belongs to someone else in the cloud: keep a copy under a fresh id.
        preserveConflict(book, '云端同步冲突');
        persist({ ...book, cloudSyncBlocked: true });
        result.conflicts.push(id);
      } else {
        // Offline / server error: retried on the next pass ('online' or next start).
        result.failed.push(id);
      }
    }
  }
  return result;
}

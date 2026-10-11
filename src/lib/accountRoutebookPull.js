// After login the homepage only reads localStorage. Cloud drafts under the account profile
// never appear until we pull them once (uploadLocalOnlyRoutebooks only goes the other way).

/**
 * @param {Record<string, any> | null | undefined} book
 * @returns {number}
 */
function routebookTimestamp(book) {
  return Math.max(0, ...[book?.provider?.editedAt, book?.updatedAt, book?.provider?.generatedAt, book?.createdAt].map((value) => Date.parse(value ?? '') || 0));
}

/**
 * @typedef {{
 *   profile: Record<string, any>,
 *   list: (profileId: string, limit?: number, signal?: AbortSignal) => Promise<{ routebooks?: Record<string, any>[] }>,
 *   getLocal: (profileId: string) => Record<string, any>[],
 *   persist: (book: Record<string, any>) => boolean,
 *   profileFields?: (profile: Record<string, any>) => Record<string, any>,
 *   signal?: AbortSignal,
 *   limit?: number
 * }} PullDeps
 */

/**
 * Download the account's cloud routebooks into local storage so Home / 我的 show them on a fresh device.
 * Newer local edits win; remote rows without stops/city are skipped (not displayable locally).
 * @param {PullDeps} deps
 * @returns {Promise<{ pulled: string[], skipped: string[], total: number, reason?: string }>}
 */
export async function pullAccountRoutebooks({ profile, list, getLocal, persist, profileFields = () => ({}), signal, limit = 80 }) {
  /** @type {{ pulled: string[], skipped: string[], total: number, reason?: string }} */
  const result = { pulled: [], skipped: [], total: 0 };
  if (!(profile?.accountUserId || profile?.profileAccessToken) || !profile?.id) {
    return { ...result, reason: 'not-signed-in' };
  }
  const data = await list(profile.id, limit, signal);
  const remote = Array.isArray(data?.routebooks) ? data.routebooks : [];
  result.total = remote.length;
  const localById = new Map(getLocal(profile.id).map((book) => [String(book.publicId || book.id || ''), book]));
  for (const book of remote) {
    const id = String(book?.publicId || book?.id || '');
    if (!id) {
      result.skipped.push('(missing-id)');
      continue;
    }
    if (!book?.city || !Array.isArray(book?.stops) || book.stops.length < 1) {
      result.skipped.push(id);
      continue;
    }
    const existing = localById.get(id);
    if (existing && routebookTimestamp(existing) > routebookTimestamp(book)) {
      result.skipped.push(id);
      continue;
    }
    const merged = {
      ...book,
      ...profileFields(profile),
      profileId: profile.id,
      // Keep a local edit token if the list row omitted it (hash-only storage).
      editToken: book.editToken || existing?.editToken
    };
    if (persist(merged)) result.pulled.push(id);
    else result.skipped.push(id);
  }
  return result;
}

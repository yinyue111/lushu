// M1: single-use store for identity-assertion nonces.
//
// A signed phone/WeChat assertion is valid for ±10 minutes. Without remembering
// which nonces were already consumed, a leaked assertion could be replayed
// inside that window to rotate the profile token (account takeover). Entries are
// kept in memory, persisted through `persist` so a restart cannot reopen the
// window, and pruned once expired.

/**
 * @typedef {{ key: string, expiresAt: number }} NonceRecord
 * @param {{
 *   load?: () => Promise<NonceRecord[]>,
 *   persist?: (record: NonceRecord) => Promise<void>,
 *   now?: () => number
 * }} [options]
 */
export function createNonceStore(options = {}) {
  const { load = async () => [], persist = async () => {}, now = () => Date.now() } = options;
  /** @type {Map<string, number>} */
  const used = new Map();
  /** @type {Promise<void> | null} */
  let loading = null;

  function prune(current) {
    for (const [key, expiresAt] of used) {
      if (expiresAt <= current) used.delete(key);
    }
  }

  async function ensureLoaded() {
    loading ??= (async () => {
      const current = now();
      for (const record of await load()) {
        const expiresAt = Number(record?.expiresAt);
        if (record?.key && Number.isFinite(expiresAt) && expiresAt > current) {
          used.set(String(record.key), Math.max(used.get(String(record.key)) ?? 0, expiresAt));
        }
      }
    })();
    await loading;
  }

  return {
    /**
     * Marks the nonce as used. Returns false when it was already consumed.
     * The check-and-set is synchronous after loading, so concurrent requests in
     * this process cannot both succeed.
     * @param {string} key
     * @param {number} expiresAt epoch ms after which the assertion is invalid anyway
     */
    async consume(key, expiresAt) {
      await ensureLoaded();
      const current = now();
      prune(current);
      if (used.has(key)) return false;
      used.set(key, expiresAt);
      await persist({ key, expiresAt });
      return true;
    },
    size() {
      return used.size;
    }
  };
}

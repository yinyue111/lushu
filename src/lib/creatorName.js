// U18: placeholder bylines that older builds stored as if they were real names.
// Read them as "no byline" everywhere (server on read, client for older local copies).
export const LEGACY_PLACEHOLDER_CREATOR_NAMES = Object.freeze(['匿名旅行者', '可信路书编辑部']);

/**
 * @param {unknown} value
 * @returns {string | null}
 */
export function publicCreatorName(value) {
  const name = String(value ?? '')
    .trim()
    .slice(0, 60);
  return !name || LEGACY_PLACEHOLDER_CREATOR_NAMES.includes(name) ? null : name;
}

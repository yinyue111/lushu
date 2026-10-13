/**
 * AI_MODEL_FALLBACK_ORDER: unset → ['fast'] (细品 fails → 轻快), `none` → [] (off), otherwise a comma list
 * of fast/deep. Unknown entries (e.g. a typo like `fats`) are reported, never silently treated as "off".
 * @param {string | undefined} raw
 * @returns {{ order: string[], invalid: string[] }}
 */
export function parseFallbackOrder(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { order: ['fast'], invalid: [] };
  if (text.toLowerCase() === 'none') return { order: [], invalid: [] };
  const items = text.split(',').map((item) => item.trim());
  const invalid = items.filter((item) => item !== 'fast' && item !== 'deep');
  return { order: items.filter((item) => item === 'fast' || item === 'deep'), invalid };
}

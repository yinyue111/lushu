// Content-safety pre-filter (pure). It never decides that content is fine on behalf of a
// real content-safety service: a hit sends the item to the ops queue; no hit means "not
// flagged by the pre-filter", which is all the keyword stage can honestly say.
import { readFileSync } from 'node:fs';

// Built-in patterns target off-platform contact / solicitation spam in public text only.
// They are deliberately narrow; policy keyword lists come from MODERATION_KEYWORDS_FILE.
const BUILTIN_PATTERNS = Object.freeze([
  { category: 'contact-phone', severity: 'review', pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/ },
  { category: 'contact-im', severity: 'review', pattern: /(加|➕|\+)\s*(微信|v信|vx|wx|qq|扣扣)|(微信|vx|wx)\s*[:：号]\s*[a-z0-9_-]{5,}/i },
  { category: 'external-link', severity: 'review', pattern: /https?:\/\/|www\.[a-z0-9-]+\./i }
]);

/**
 * Keyword file format: one entry per line, `block:词`, `review:词`, or a bare word
 * (= review). `#` starts a comment. Matching is case-insensitive substring after NFKC.
 * @param {string} text
 */
export function parseKeywordList(text) {
  const entries = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const match = /^(block|review):(.+)$/i.exec(line);
    const term = (match ? match[2] : line).trim().normalize('NFKC').toLowerCase();
    if (term) entries.push({ term, severity: match ? match[1].toLowerCase() : 'review' });
  }
  return entries;
}

export function loadKeywordFile(path) {
  if (!path) return [];
  try {
    return parseKeywordList(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
}

/**
 * @param {Record<string, string>} fields
 * @param {{ keywords?: Array<{ term: string, severity: string }>, builtins?: boolean }} [options]
 */
export function keywordPrefilter(fields, { keywords = [], builtins = true } = {}) {
  const hits = [];
  for (const [field, value] of Object.entries(fields ?? {})) {
    const text = String(value ?? '')
      .normalize('NFKC')
      .toLowerCase();
    if (!text.trim()) continue;
    if (builtins) for (const rule of BUILTIN_PATTERNS) if (rule.pattern.test(text)) hits.push({ field, category: rule.category, severity: rule.severity });
    for (const entry of keywords) if (text.includes(entry.term)) hits.push({ field, category: 'keyword', severity: entry.severity });
  }
  const decision = hits.some((hit) => hit.severity === 'block') ? 'block' : hits.length ? 'review' : 'pass';
  // Matched terms are not echoed back: the list itself is policy data.
  return { decision, hits };
}

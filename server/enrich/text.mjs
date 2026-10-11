// Value normalization shared by the enrichment checks.

export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** Text with spacing removed and punctuation unified, for literal containment checks. */
export function compact(text) {
  return String(text ?? '')
    .replace(/\s+/g, '')
    .replace(/[：]/g, ':')
    .replace(/[—–~～至到]/g, '-')
    .replace(/[￥]/g, '¥');
}

const ALL_DAY = /全天开放|全天候开放|24\s*小时(?:开放|营业)?|全天24小时|00:00\s*-\s*24:00|0:00\s*-\s*24:00/;

/**
 * Opening hours → canonical "HH:MM-HH:MM" (first range), "00:00-24:00" for all-day, or '' if none.
 * @param {string} value
 */
export function canonicalHours(value) {
  const text = compact(value);
  if (ALL_DAY.test(text)) return '00:00-24:00';
  const times = text.match(/\d{1,2}:\d{2}/g) ?? [];
  if (times.length < 2) return '';
  const pad = (t) => t.padStart(5, '0');
  return `${pad(times[0])}-${pad(times[1])}`;
}

/** Tokens that must literally appear on a page for the hours to count as supported there. */
export function hoursEvidence(canonical) {
  if (canonical === '00:00-24:00') return [ALL_DAY];
  const [open, close] = canonical.split('-');
  const loose = (t) => new RegExp(`(?<!\\d)0?${t.replace(/^0/, '')}(?!\\d)`);
  return [loose(open), loose(close)];
}

/**
 * Ticket price → { free: true } | { amount: number } | null.
 * @param {string} value
 */
export function canonicalPrice(value) {
  const text = compact(value);
  if (!text) return null;
  if (/免费|免票|无需门票|不收门票|0元/.test(text)) return { free: true };
  const m = text.match(/(?:¥|门票|票价)?(\d+(?:\.\d+)?)元?/);
  return m ? { amount: Number(m[1]) } : null;
}

export function priceEvidence(price) {
  if (price.free) return [/免费|免票|无需门票|不收门票|免门票/];
  const n = String(price.amount).replace(/\.0+$/, '');
  return [new RegExp(`(?:¥|￥)\\s*${n}(?!\\d)|(?<!\\d)${n}\\s*元`)];
}

export const priceKey = (price) => (price ? (price.free ? 'free' : `¥${price.amount}`) : '');
export const priceDisplay = (price) => (price.free ? '免费' : `${price.amount} 元`);

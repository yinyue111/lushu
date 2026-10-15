/**
 * Optional trip start date as YYYY-MM-DD (device-local calendar).
 * UI only picks month/day; year is the next upcoming occurrence on/after today.
 * Empty string = 不填.
 */

/**
 * @param {Date} [now]
 * @returns {{ year: number, month: number, day: number }}
 */
export function localYmd(now = new Date()) {
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
}

/**
 * @param {string | undefined | null} value
 * @returns {{ year: number, month: number, day: number } | null}
 */
export function parseYmd(value) {
  const raw = String(value ?? '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isInteger(year) || month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

/**
 * @param {number} year
 * @param {number} month 1-12
 */
export function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

/**
 * Year of the next upcoming calendar month `month` (1–12) relative to `now` (local).
 * If we are still in that month this year, returns this year; otherwise the next time it occurs.
 * Never skips more than one year ahead.
 * @param {number} month
 * @param {Date} [now]
 */
export function yearForUpcomingMonth(month, now = new Date()) {
  const today = localYmd(now);
  if (month < 1 || month > 12) return today.year;
  return today.month <= month ? today.year : today.year + 1;
}

/**
 * Valid day numbers for `month` in the next upcoming occurrence of that month.
 * Feb 29 appears only when that upcoming February is a leap year.
 * @param {number} month
 * @param {Date} [now]
 * @returns {number[]}
 */
export function dayOptionsForMonth(month, now = new Date()) {
  if (!month) return [];
  const year = yearForUpcomingMonth(month, now);
  const max = daysInMonth(year, month);
  return Array.from({ length: max }, (_, i) => i + 1);
}

/**
 * Resolve month/day to YYYY-MM-DD: next occurrence on/after today (local).
 * Today + same month/day → today. Invalid day for that month → null.
 * @param {number} month
 * @param {number} day
 * @param {Date} [now]
 * @returns {string | null}
 */
export function resolveTripDate(month, day, now = new Date()) {
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(m) || !Number.isInteger(d) || m < 1 || m > 12 || d < 1) return null;
  const today = localYmd(now);
  let year = today.year;
  if (m < today.month || (m === today.month && d < today.day)) year = today.year + 1;
  if (d > daysInMonth(year, m)) return null;
  return formatYmd({ year, month: m, day: d });
}

/**
 * @param {{ year: number, month: number, day: number }} parts
 * @returns {string}
 */
export function formatYmd({ year, month, day }) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * @param {number} year
 * @param {number} month
 * @param {number} day
 */
export function clampDay(year, month, day) {
  return Math.min(Math.max(1, day), daysInMonth(year, month));
}

/**
 * True when a stored YYYY-MM-DD is before today's local date. Never rewrites the value.
 * @param {string | undefined | null} value
 * @param {Date} [now]
 */
export function isPastTripDate(value, now = new Date()) {
  const parsed = parseYmd(value);
  if (!parsed) return false;
  return formatYmd(parsed) < formatYmd(localYmd(now));
}

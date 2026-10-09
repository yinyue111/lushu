// Keyset (timestamp desc, id desc) cursor paging shared by ops listings (F17).
import { createHttpError, sanitizePublicId } from '../lib/util.mjs';

export function rowTimestamp(row, fields = ['updatedAt', 'createdAt']) {
  for (const field of fields) {
    const value = Date.parse(row?.[field] ?? '');
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

export function compareRowsDesc(left, right, fields) {
  return rowTimestamp(right, fields) - rowTimestamp(left, fields) || String(right?.id ?? '').localeCompare(String(left?.id ?? ''));
}

/** True when `row` sorts strictly after the cursor position (i.e. is older). */
export function isAfterCursor(row, cursor, fields) {
  if (!cursor) return true;
  const timestamp = rowTimestamp(row, fields);
  return timestamp < cursor.timestamp || (timestamp === cursor.timestamp && String(row?.id ?? '').localeCompare(cursor.id) < 0);
}

export function encodeCursor(row, fields) {
  return Buffer.from(JSON.stringify({ timestamp: rowTimestamp(row, fields), id: String(row?.id ?? '') }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor) {
  const value = String(cursor ?? '').trim();
  if (!value) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!decoded || !Number.isSafeInteger(decoded.timestamp) || decoded.timestamp < 0 || !sanitizePublicId(decoded.id)) throw new Error('invalid');
    return { timestamp: decoded.timestamp, id: sanitizePublicId(decoded.id) };
  } catch {
    throw createHttpError('分页游标无效，请刷新后重试', 400, 'INVALID_CURSOR');
  }
}

/**
 * Sort, skip past the cursor and slice one page.
 * @param {any[]} rows
 * @param {{ limit: number, cursor?: string, fields?: string[] }} options
 */
export function paginateRows(rows, { limit, cursor = '', fields } = /** @type {any} */ ({})) {
  const position = decodeCursor(cursor);
  const sorted = [...rows].sort((left, right) => compareRowsDesc(left, right, fields));
  const remaining = sorted.filter((row) => isAfterCursor(row, position, fields));
  const page = remaining.slice(0, limit);
  const hasMore = remaining.length > page.length;
  return { page, total: sorted.length, nextCursor: hasMore && page.length ? encodeCursor(page.at(-1), fields) : '', hasMore };
}

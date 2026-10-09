// Server-side POI correction review queue.
//
// The queue is intentionally projected from the latest row for each correction
// id before status filtering and pagination.  This keeps an old pending row from
// reappearing after the same correction has been approved/rejected, and avoids
// the previous "read a recent window, then filter in the browser" behaviour.
import { readFile } from 'node:fs/promises';
import { POI_CORRECTION_LOG_PATH } from '../config/index.mjs';
import { createHttpError, sanitizePublicId, clampNumber } from '../lib/util.mjs';
import { readJsonLines } from '../storage/jsonl.mjs';
import { usesPostgresStorage } from '../storage/runtime.mjs';

const REVIEW_STATUSES = new Set(['pending', 'approved', 'rejected']);
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * List the latest correction state with server-side filtering and cursor paging.
 * @param {{ city?: string, status?: string, limit?: number|string, cursor?: string }} [input]
 */
export async function listReviewQueue({ city = '', status = '', limit = DEFAULT_LIMIT, cursor = '' } = {}) {
  const normalizedCity = String(city ?? '').trim();
  const normalizedStatus = String(status ?? '').trim();
  if (normalizedStatus && !REVIEW_STATUSES.has(normalizedStatus)) {
    throw createHttpError('审核状态只能是 pending/approved/rejected', 400, 'INVALID_REVIEW_STATUS');
  }
  const pageSize = clampNumber(limit, 1, MAX_LIMIT, DEFAULT_LIMIT);
  const position = decodeReviewQueueCursor(cursor);
  const latest = new Map();
  for (const row of await readAllCorrectionRows()) {
    const id = sanitizePublicId(row?.id);
    if (!id) continue;
    latest.set(id, { ...row, id, status: normalizeReviewStatus(row?.status || row?.reviewStatus) });
  }

  const rows = [...latest.values()]
    .filter((row) => !normalizedCity || String(row.city ?? '').trim() === normalizedCity)
    .filter((row) => !normalizedStatus || row.status === normalizedStatus)
    .sort(compareReviewRows);
  const total = rows.length;
  const start = position ? rows.findIndex((row) => isAfterCursor(row, position)) : 0;
  const offset = start < 0 ? total : start;
  const page = rows.slice(offset, offset + pageSize);
  const last = page.at(-1);
  const nextCursor = last && offset + page.length < total ? encodeReviewQueueCursor(last) : '';
  return {
    corrections: page,
    total,
    limit: pageSize,
    city: normalizedCity || 'all',
    status: normalizedStatus || 'all',
    cities: [...new Set([...latest.values()].map((row) => String(row.city ?? '').trim()).filter(Boolean))].sort((left, right) =>
      left.localeCompare(right, 'zh-CN')
    ),
    nextCursor,
    hasMore: Boolean(nextCursor)
  };
}

async function readAllCorrectionRows() {
  if (usesPostgresStorage()) return readJsonLines(POI_CORRECTION_LOG_PATH, Number.POSITIVE_INFINITY);
  let content;
  try {
    content = await readFile(POI_CORRECTION_LOG_PATH, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const rows = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object' && !Array.isArray(row)) rows.push(row);
    } catch {
      // Ignore a malformed historical line; it must not make the whole queue
      // unavailable, while valid rows remain auditable.
    }
  }
  return rows;
}

function normalizeReviewStatus(value) {
  return REVIEW_STATUSES.has(String(value ?? '').trim()) ? String(value).trim() : 'pending';
}

function reviewRowTimestamp(row) {
  const value = row?.reviewedAt || row?.updatedAt || row?.createdAt || '';
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareReviewRows(left, right) {
  return reviewRowTimestamp(right) - reviewRowTimestamp(left) || String(right.id).localeCompare(String(left.id));
}

function isAfterCursor(row, cursor) {
  const timestamp = reviewRowTimestamp(row);
  return timestamp < cursor.timestamp || (timestamp === cursor.timestamp && String(row.id).localeCompare(cursor.id) < 0);
}

function encodeReviewQueueCursor(row) {
  return Buffer.from(JSON.stringify({ timestamp: reviewRowTimestamp(row), id: String(row.id) }), 'utf8').toString('base64url');
}

function decodeReviewQueueCursor(cursor) {
  const value = String(cursor ?? '').trim();
  if (!value) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!decoded || !Number.isSafeInteger(decoded.timestamp) || decoded.timestamp < 0 || !sanitizePublicId(decoded.id)) {
      throw new Error('invalid cursor');
    }
    return { timestamp: decoded.timestamp, id: sanitizePublicId(decoded.id) };
  } catch {
    throw createHttpError('审核队列游标无效，请刷新后重试', 400, 'INVALID_REVIEW_CURSOR');
  }
}

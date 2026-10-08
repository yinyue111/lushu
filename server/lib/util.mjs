// Small pure helpers shared by every server module (ids, strings, numbers, errors).
import { createHash } from 'node:crypto';

export function sanitizePublicId(value) {
  return String(value ?? '').trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);
}

export function stablePublicId(value, prefix = 'id') {
  const sanitized = sanitizePublicId(value);
  if (/[A-Za-z0-9]/.test(sanitized)) return sanitized;
  const text = String(value ?? '').trim();
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return `${sanitizePublicId(prefix) || 'id'}-${Math.abs(hash || Date.now()).toString(36)}`.slice(0, 80);
}

export function parseMoney(value) {
  const matches = String(value ?? '').match(/\d+/g);
  if (!matches?.length) return 0;
  return matches.map(Number).filter(Number.isFinite).reduce((sum, item) => sum + item, 0);
}

export function distanceMeters(a, b) {
  const lat1 = Number(a?.lat);
  const lng1 = Number(a?.lng);
  const lat2 = Number(b?.lat);
  const lng2 = Number(b?.lng);
  if (!isValidCoordinate(lat1, lng1) || !isValidCoordinate(lat2, lng2)) return null;
  const toRad = (value) => (value * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)));
}

export function positiveInteger(value, fallback = null) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

export function maxIso(a, b) {
  return String(a ?? '').localeCompare(String(b ?? '')) >= 0 ? a : b;
}

export function countBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows ?? []) {
    const key = keyFn(row);
    if (!key) continue;
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return map;
}

export function percent(numerator, denominator) {
  return denominator ? Math.round((numerator / denominator) * 1000) / 10 : null;
}

export function intersectSets(left, right) {
  return new Set([...left].filter((key) => right.has(key)));
}

export function canonicalizeJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalizeJsonValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, canonicalizeJsonValue(value[key])])
    );
  }
  return value;
}

export function stableJsonStringify(value) {
  return JSON.stringify(canonicalizeJsonValue(value));
}

export function isHttpUrl(value) {
  try {
    const url = new URL(String(value ?? ''));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function nullablePercent(numerator, denominator) {
  return denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : null;
}

/**
 * @param {string} message
 * @param {number} statusCode
 * @param {string} [code]
 * @returns {Error & Record<string, any>}
 */
export function createHttpError(message, statusCode, code) {
  const error = /** @type {Error & Record<string, any>} */ (new Error(message));
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

// 路由参数解码：非法百分号序列（如 %zz）会让 decodeURIComponent 抛
// URIError 并被兜底成 500，这里统一转成 400 BAD_PATH。
export function safeDecodePathSegment(value) {
  try {
    return decodeURIComponent(String(value ?? ''));
  } catch {
    throw createHttpError('请求路径编码不合法', 400, 'BAD_PATH');
  }
}

export function hashText(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 16);
}

export function truncateString(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}

export function normalizeCityName(value) {
  const city = truncateString(value, 40).replace(/市$/u, '');
  if (!city) return '杭州';
  if (!/^[\p{Script=Han}A-Za-z0-9·.\-\s]+$/u.test(city)) {
    throw createHttpError('目的地城市名称包含不支持的字符', 400, 'BAD_CITY');
  }
  return city;
}

export function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

export function isValidCoordinate(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

export function normalizeRoutebookActorType(value) {
  const actorType = truncateString(value, 24);
  return ['user', 'admin', 'system', 'migration'].includes(actorType) ? actorType : 'system';
}

export async function mapWithConcurrency(items, concurrency, mapper) {
  const output = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return output;
}

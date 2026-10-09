// Small pure helpers shared by every server module (ids, strings, numbers, errors).
import { createHash } from 'node:crypto';

export function sanitizePublicId(value) {
  return String(value ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 80);
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

/**
 * Parse a user-facing money value without treating ranges, thousands
 * separators, or placeholders as a list of unrelated integers.
 *
 * The old parser summed every digit group, so `80-120 元` became 200 and
 * `1,200 元` became 201.  Keep the scalar parseMoney API for older callers,
 * but make it return the range midpoint while exposing the structured range
 * to callers that need to report uncertainty.
 */
export function parseMoneyRange(value) {
  const raw = String(value ?? '').trim();
  const text = raw
    .replace(/，/g, ',')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ');
  const normalized = text.toLocaleLowerCase('zh-CN');
  const unknown = (reason = 'unknown') => ({
    raw,
    known: false,
    isRange: false,
    min: null,
    max: null,
    estimate: null,
    reason
  });

  if (!text) return unknown('missing');
  if (/^(?:免费|免票|无费用|无需费用|不收费|0(?:\s*元)?|zero|free)$/.test(normalized)) {
    return { raw, known: true, isRange: false, min: 0, max: 0, estimate: 0, reason: 'free' };
  }
  if (/^(?:待估算|待确认|未知|不详|面议|价格待定|暂无|无数据|n\/a|na|none|null|-)$/i.test(normalized)) {
    return unknown('unavailable');
  }

  // A range separator is only accepted when it has a number on both sides;
  // this preserves dates and prose that happen to contain a hyphen.
  const numberPattern = '(\\d[\\d,]*(?:\\.\\d+)?)';
  const rangeMatch = text.match(new RegExp(`${numberPattern}\\s*(?:-|–|—|~|～|至|到)\\s*${numberPattern}`));
  const toNumber = (token) => Number(String(token).replace(/[,\s]/g, ''));
  if (rangeMatch) {
    const left = toNumber(rangeMatch[1]);
    const right = toNumber(rangeMatch[2]);
    if (Number.isFinite(left) && Number.isFinite(right)) {
      const min = Math.min(left, right);
      const max = Math.max(left, right);
      return {
        raw,
        known: true,
        isRange: min !== max,
        min,
        max,
        estimate: roundMoney((min + max) / 2),
        reason: 'range'
      };
    }
  }

  const singleMatch = text.match(/\d[\d,]*(?:\.\d+)?/);
  if (!singleMatch) return unknown('unavailable');
  const amount = toNumber(singleMatch[0]);
  if (!Number.isFinite(amount)) return unknown('unavailable');
  return { raw, known: true, isRange: false, min: amount, max: amount, estimate: amount, reason: 'exact' };
}

/**
 * Backwards-compatible scalar helper.  New validation code should prefer
 * parseMoneyRange so it can preserve lower/upper bounds and unknown values.
 */
export function parseMoney(value) {
  return parseMoneyRange(value).estimate ?? 0;
}

export function sumMoneyRanges(values = []) {
  const rows = (Array.isArray(values) ? values : [values]).map(parseMoneyRange);
  const known = rows.filter((row) => row.known);
  const unknownCount = rows.length - known.length;
  if (!known.length) {
    return { knownCount: 0, unknownCount, allKnown: unknownCount === 0, min: null, max: null, estimate: null };
  }
  return {
    knownCount: known.length,
    unknownCount,
    allKnown: unknownCount === 0,
    min: roundMoney(known.reduce((sum, row) => sum + row.min, 0)),
    max: roundMoney(known.reduce((sum, row) => sum + row.max, 0)),
    estimate: roundMoney(known.reduce((sum, row) => sum + row.estimate, 0))
  };
}

function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100;
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
  return createHash('sha256')
    .update(String(value ?? ''))
    .digest('hex')
    .slice(0, 16);
}

export function truncateString(value, maxLength) {
  return String(value ?? '')
    .trim()
    .slice(0, maxLength);
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

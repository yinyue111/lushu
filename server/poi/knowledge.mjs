// POI corrections and the knowledge derived from approved corrections.
import { createHttpError, normalizeCityName, truncateString, sanitizePublicId } from '../lib/util.mjs';
import { cryptoRandomId } from '../auth/tokens.mjs';
import { POI_CORRECTION_LOG_PATH, POI_KNOWLEDGE_LOG_PATH } from '../config/index.mjs';
import { readLatestUniqueJsonLines, appendJsonLine } from '../storage/jsonl.mjs';
import { poiCorrectionIndex } from '../storage/records.mjs';

/**
 * Correction categories. The form used to offer a combined "开放时间/价格"
 * option, so a price correction counted as an hours/closure signal. Each
 * correction now carries a single category; only `hours` and `closure` feed the
 * POI hours/closure trust flag.
 */
export const POI_CORRECTION_CATEGORIES = Object.freeze({
  hours: '开放时间',
  closure: '闭店/暂停',
  price: '价格',
  location: '位置坐标',
  crowd: '排队/拥挤',
  audience: '适合人群',
  other: '其他'
});

const CLOSURE_TEXT = /已?(?:关门|倒闭|停业|歇业|闭店|拆除|不再营业|暂停(?:开放|营业)|永久关闭|闭园|闭馆中|关闭了)/;
const HOURS_TEXT = /开放时间|营业时间|开门|几点|\d{1,2}\s*[:：点]\s*\d{0,2}|周[一二三四五六日天]\s*(?:闭馆|休息|不开)|闭馆|最晚入场/;
const PRICE_TEXT = /价格|门票|票价|涨价|降价|免费|收费|人均|\d+(?:\.\d+)?\s*(?:元|块)|[¥￥]\s*\d/;

/**
 * @param {{ field?: string, category?: string, suggestedValue?: string, reason?: string }} correction
 * @returns {keyof typeof POI_CORRECTION_CATEGORIES}
 */
export function classifyPoiCorrection(correction) {
  if (Object.hasOwn(POI_CORRECTION_CATEGORIES, correction?.category)) return /** @type {any} */ (correction.category);
  const field = String(correction?.field ?? '');
  const text = `${correction?.suggestedValue ?? ''} ${correction?.reason ?? ''}`;
  if (/闭店|暂停|停业|关闭|歇业/.test(field)) return 'closure';
  if (/位置|坐标|地址/.test(field)) return 'location';
  if (/排队|拥挤/.test(field)) return 'crowd';
  if (/人群/.test(field)) return 'audience';
  if (field === '价格' || /^(?:价格|门票|费用)$/.test(field)) return 'price';
  if (/^(?:开放时间|营业时间)$/.test(field)) return 'hours';
  // Legacy combined option ("开放时间/价格") and free-form fields: decide from the text.
  if (CLOSURE_TEXT.test(text)) return 'closure';
  if (/开放|营业/.test(field) && /价格/.test(field)) {
    const hours = HOURS_TEXT.test(text);
    const price = PRICE_TEXT.test(text);
    if (hours && !price) return 'hours';
    if (price && !hours) return 'price';
    return 'other';
  }
  if (/开放|营业|闭馆|闭园/.test(field)) return 'hours';
  return 'other';
}

/** Hours/closure corrections only (price, crowd, etc. never mark a POI as possibly closed). */
export function isHoursOrClosureCorrection(correction) {
  const category = classifyPoiCorrection(correction);
  return category === 'hours' || category === 'closure';
}

export function normalizePoiCorrection(input) {
  const name = truncateString(input?.stopName ?? input?.name, 80);
  if (!name) throw createHttpError('请提供要纠错的 POI 名称', 400, 'POI_NAME_REQUIRED');
  return {
    id: cryptoRandomId(),
    routeTitle: truncateString(input?.routeTitle, 100),
    city: input?.city ? normalizeCityName(input.city) : '',
    stopId: truncateString(input?.stopId, 40),
    stopName: name,
    field: truncateString(input?.field, 40) || '综合信息',
    category: classifyPoiCorrection({
      category: input?.category,
      field: input?.field,
      suggestedValue: input?.suggestedValue,
      reason: input?.reason
    }),
    currentValue: truncateString(input?.currentValue, 300),
    suggestedValue: truncateString(input?.suggestedValue, 500),
    reason: truncateString(input?.reason, 500),
    contact: truncateString(input?.contact, 120),
    status: 'pending',
    createdAt: new Date().toISOString()
  };
}

export async function listPoiCorrections(limit = 50, { status = '' } = {}) {
  const safeLimit = Math.max(1, Number.isFinite(Number(limit)) ? Number(limit) : 50);
  const statusFilter = truncateString(status, 24);
  // 按 id 去重取最新一行，并在扫描时按最新状态筛选（H4：不再先截断窗口再过滤）。
  return readLatestUniqueJsonLines(
    POI_CORRECTION_LOG_PATH,
    (row) => sanitizePublicId(row?.id),
    safeLimit,
    100000,
    statusFilter ? (row) => String(row?.status ?? '') === statusFilter : null
  );
}

export async function updatePoiCorrectionStatus(id, input) {
  const correctionId = sanitizePublicId(id);
  const action = String(input?.action ?? '').trim();
  if (!['approved', 'rejected'].includes(action)) {
    throw createHttpError('纠错状态只能是 approved 或 rejected', 400, 'BAD_CORRECTION_STATUS');
  }
  if (!correctionId) throw createHttpError('纠错记录不存在', 404, 'CORRECTION_NOT_FOUND');
  // 按 id 全文件倒扫最新一行，避免旧纠错被尾窗挤出后无法审核。
  const existing = await poiCorrectionIndex.get(correctionId);
  if (!existing) throw createHttpError('纠错记录不存在', 404, 'CORRECTION_NOT_FOUND');
  const updated = {
    ...existing,
    status: action,
    reviewerNote: truncateString(input?.reviewerNote, 400),
    reviewedAt: new Date().toISOString()
  };
  await appendJsonLine(POI_CORRECTION_LOG_PATH, updated);
  if (action === 'approved') {
    await appendJsonLine(POI_KNOWLEDGE_LOG_PATH, normalizePoiKnowledgeFromCorrection(updated));
  }
  return updated;
}

function poiKnowledgeKey(city, stopName, field = '') {
  return [normalizeCityName(city || '未知'), truncateString(stopName, 80), truncateString(field, 40)].map((item) => String(item ?? '').trim()).join('::');
}

function normalizePoiKnowledgeFromCorrection(correction) {
  const city = correction?.city ? normalizeCityName(correction.city) : '';
  const stopName = truncateString(correction?.stopName, 80);
  return {
    id: sanitizePublicId(correction?.id) || cryptoRandomId(),
    correctionId: sanitizePublicId(correction?.id),
    city,
    stopName,
    field: truncateString(correction?.field, 40) || '综合信息',
    value: truncateString(correction?.suggestedValue, 500),
    reason: truncateString(correction?.reason, 500),
    routeTitle: truncateString(correction?.routeTitle, 100),
    reviewerNote: truncateString(correction?.reviewerNote, 400),
    status: 'approved',
    trustDelta: 3,
    createdAt: correction?.reviewedAt || new Date().toISOString()
  };
}

export async function listPoiKnowledge({ city = '', stopName = '', limit = 80 } = {}) {
  // H4: the key embeds city + stop name, so filtering each key's latest row during the
  // scan is equivalent to the old filter-then-dedupe, without the truncated window.
  const rowCity = (row) => (row?.city ? normalizeCityName(row.city) : '');
  return readLatestUniqueJsonLines(
    POI_KNOWLEDGE_LOG_PATH,
    (row) => poiKnowledgeKey(rowCity(row), String(row?.stopName ?? ''), row?.field),
    limit,
    100000,
    (row) => {
      const rowStopName = String(row?.stopName ?? '');
      const cityMatched = !city || rowCity(row) === city;
      const stopMatched = !stopName || rowStopName === stopName || rowStopName.includes(stopName) || stopName.includes(rowStopName);
      return cityMatched && stopMatched;
    }
  );
}

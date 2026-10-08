// POI corrections and the knowledge derived from approved corrections.
import { createHttpError, normalizeCityName, truncateString, sanitizePublicId } from '../lib/util.mjs';
import { cryptoRandomId } from '../auth/tokens.mjs';
import { POI_CORRECTION_LOG_PATH, POI_KNOWLEDGE_LOG_PATH } from '../config/index.mjs';
import { readLatestUniqueJsonLines, appendJsonLine } from '../storage/jsonl.mjs';
import { poiCorrectionIndex } from '../storage/records.mjs';

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

export function poiKnowledgeKey(city, stopName, field = '') {
  return [normalizeCityName(city || '未知'), truncateString(stopName, 80), truncateString(field, 40)]
    .map((item) => String(item ?? '').trim())
    .join('::');
}

export function normalizePoiKnowledgeFromCorrection(correction) {
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

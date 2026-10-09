// Exposure event normalisation.
import { truncateString, normalizeCityName, sanitizePublicId, stablePublicId, createHttpError } from '../lib/util.mjs';
import { cryptoRandomId, normalizeProfileId } from '../auth/tokens.mjs';
import { resolveTravelDate } from '../routebooks/normalize.mjs';
import { CLICK_LOG_PATH, EXPOSURE_LOG_PATH } from '../config/index.mjs';
import { appendJsonLine, findLatestJsonLine } from '../storage/jsonl.mjs';
import { findLatestByEntityKey } from '../storage/keyedLookup.mjs';
import { withStorageEntityLock } from '../storage/runtime.mjs';
import { productExposureMatchesClick } from './productFunnel.mjs';

export function normalizeProductTelemetryId(value) {
  const id = String(value ?? '').trim();
  if (!id) return '';
  if (!/^[A-Za-z0-9_-]{8,96}$/.test(id)) throw createHttpError('商品埋点标识格式无效', 400, 'PRODUCT_TELEMETRY_ID_INVALID');
  return id;
}

export async function persistProductExposure(row) {
  return withStorageEntityLock('product-exposure', row.exposureId, async () => {
    const existing = await findLatestByEntityKey(EXPOSURE_LOG_PATH, row.exposureId);
    if (existing) {
      if (!productExposureMatchesClick(existing, row)) throw createHttpError('exposureId 已绑定到其他商品曝光上下文', 409, 'PRODUCT_EXPOSURE_CONFLICT');
      return { exposure: existing, deduplicated: true };
    }
    await appendJsonLine(EXPOSURE_LOG_PATH, row);
    return { exposure: row, deduplicated: false };
  });
}

export async function persistProductClick(row) {
  if (!row.exposureId) {
    const click = { ...row, attributionStatus: 'unattributed', unattributedReason: 'missing-exposure-context' };
    await appendJsonLine(CLICK_LOG_PATH, click);
    return { click, deduplicated: false };
  }
  return withStorageEntityLock('product-exposure', row.exposureId, async () => {
    const exposure = await findLatestByEntityKey(EXPOSURE_LOG_PATH, row.exposureId);
    if (!exposure) throw createHttpError('商品点击缺少同会话曝光，未记录归因', 400, 'PRODUCT_EXPOSURE_REQUIRED');
    if (!productExposureMatchesClick(exposure, row)) throw createHttpError('商品点击与曝光上下文不一致，未记录归因', 400, 'PRODUCT_EXPOSURE_MISMATCH');
    const existing = await findLatestJsonLine(
      CLICK_LOG_PATH,
      (item) => item?.exposureId === row.exposureId && item?.attributionStatus === 'attributed',
      Infinity
    );
    if (existing) return { click: existing, deduplicated: true };
    const click = { ...row, attributionStatus: 'attributed' };
    await appendJsonLine(CLICK_LOG_PATH, click);
    return { click, deduplicated: false };
  });
}

// 客户端可直接上报的曝光类型白名单；routebook-copy 属于计费/激励口径，
// 只允许 POST /api/routebooks/:id/copy 内部落库，防止刷复制量。
export const PUBLIC_EXPOSURE_ITEM_TYPES = new Set(['routebook', 'product', 'journey-event']);
export const INTERNAL_EXPOSURE_ITEM_TYPES = new Set(['routebook-copy']);

export function sanitizeExposureSurface(value) {
  const surface = truncateString(value, 40)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '');
  return surface || 'unknown';
}

export function normalizeExposure(input = {}, derived = {}) {
  const surface = sanitizeExposureSurface(input?.surface);
  const requestedItemType = truncateString(derived.itemType || input?.itemType || input?.type, 40) || 'routebook';
  const itemType = PUBLIC_EXPOSURE_ITEM_TYPES.has(requestedItemType) || INTERNAL_EXPOSURE_ITEM_TYPES.has(requestedItemType) ? requestedItemType : 'routebook';
  const itemId = stablePublicId(derived.itemId || input?.itemId || input?.routeId || input?.productId || input?.title, itemType);
  const exposureId = itemType === 'product' ? normalizeProductTelemetryId(input?.exposureId) : '';
  const sessionId = itemType === 'product' ? normalizeProductTelemetryId(input?.sessionId) : sanitizePublicId(input?.sessionId);
  if (exposureId && !sessionId) throw createHttpError('商品曝光关联需要 sessionId', 400, 'PRODUCT_SESSION_REQUIRED');
  if (exposureId && surface === 'unknown') throw createHttpError('商品曝光关联需要明确 surface', 400, 'PRODUCT_SURFACE_REQUIRED');
  return {
    id: exposureId || cryptoRandomId(),
    ...(exposureId ? { exposureId } : {}),
    profileId: normalizeProfileId(input?.profileId),
    sessionId,
    surface,
    itemType,
    itemId,
    routeId: sanitizePublicId(derived.routeId || input?.routeId || input?.publicId),
    routeTitle: truncateString(derived.routeTitle || input?.routeTitle || input?.title, 100),
    stopId: truncateString(input?.stopId, 40),
    stopName: truncateString(input?.stopName, 80),
    productId: derived.productId || (input?.productId ? stablePublicId(input.productId, 'product') : ''),
    productTitle: truncateString(derived.productTitle || input?.productTitle || input?.product, 100),
    city: derived.city || (input?.city ? normalizeCityName(input.city) : ''),
    creatorId: sanitizePublicId(derived.creatorId || input?.creatorId),
    sourcePosition: truncateString(input?.sourcePosition, 40),
    travelDate: itemType === 'journey-event' ? resolveTravelDate(input?.travelDate, input?.constraints?.date, input?.provider?.travelDate) : '',
    createdAt: new Date().toISOString()
  };
}

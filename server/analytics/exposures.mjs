// Exposure event normalisation.
import { truncateString, normalizeCityName, sanitizePublicId, stablePublicId } from '../lib/util.mjs';
import { cryptoRandomId, normalizeProfileId } from '../auth/tokens.mjs';
import { resolveTravelDate } from '../routebooks/normalize.mjs';

// 客户端可直接上报的曝光类型白名单；routebook-copy 属于计费/激励口径，
// 只允许 POST /api/routebooks/:id/copy 内部落库，防止刷复制量。
export const PUBLIC_EXPOSURE_ITEM_TYPES = new Set(['routebook', 'product', 'journey-event']);
export const INTERNAL_EXPOSURE_ITEM_TYPES = new Set(['routebook-copy']);

export function sanitizeExposureSurface(value) {
  const surface = truncateString(value, 40).toLowerCase().replace(/[^a-z0-9-]/g, '');
  return surface || 'unknown';
}

export function normalizeExposure(input = {}, derived = {}) {
  const surface = sanitizeExposureSurface(input?.surface);
  const requestedItemType = truncateString(derived.itemType || input?.itemType || input?.type, 40) || 'routebook';
  const itemType = PUBLIC_EXPOSURE_ITEM_TYPES.has(requestedItemType) || INTERNAL_EXPOSURE_ITEM_TYPES.has(requestedItemType)
    ? requestedItemType
    : 'routebook';
  const itemId = stablePublicId(derived.itemId || input?.itemId || input?.routeId || input?.productId || input?.title, itemType);
  return {
    id: cryptoRandomId(),
    profileId: normalizeProfileId(input?.profileId),
    sessionId: sanitizePublicId(input?.sessionId),
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
    travelDate: itemType === 'journey-event'
      ? resolveTravelDate(input?.travelDate, input?.constraints?.date, input?.provider?.travelDate)
      : '',
    createdAt: new Date().toISOString()
  };
}

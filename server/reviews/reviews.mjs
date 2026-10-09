// Shared route reviews.
import { createHttpError, sanitizePublicId, truncateString } from '../lib/util.mjs';
import { CHECKIN_LOG_PATH, MAX_ROUTEBOOK_STOPS } from '../config/index.mjs';
import { readMatchingJsonLines } from '../storage/jsonl.mjs';
import { cryptoRandomId, normalizeProfileId } from '../auth/tokens.mjs';
import { normalizeRoutebookForStorage, getResolvableRoutebook } from '../routebooks/normalize.mjs';
import { isPublicTrustEligibleCheckin, latestCheckinsByStop } from '../trust/checkins.mjs';
import { isPublicRoutebook, publicCheckinForReview, publicRoutebookView, publicRoutebookStop } from '../routebooks/views.mjs';
import { normalizeCheckinPhotoId } from '../photos/checkin-photos.mjs';
import { applyCheckinOpsOverlay, buildOpsAuditContext, isOpsSuppressedCheckin } from '../ops/audit.mjs';

export async function normalizeReviewShare(input, canonicalRoutebook = null, options = {}) {
  const routebook = canonicalRoutebook
    ? normalizeRoutebookForStorage(canonicalRoutebook, canonicalRoutebook.publicId || canonicalRoutebook.id)
    : normalizeRoutebookForStorage(input?.routebook ?? input);
  if (!isPublicRoutebook(routebook)) {
    throw createHttpError('路书公开发布后才能生成回顾分享页', 403, 'REVIEW_ROUTE_NOT_PUBLIC');
  }
  const profileId = normalizeProfileId(options.profileId || input?.profileId || 'anonymous');
  const routeId = sanitizePublicId(routebook.publicId || routebook.id);
  // 按 profile + route 谓词精确反扫，避免全局尾窗把老用户的打卡挤出统计窗口。
  const persistedCheckins =
    options.includePersistedProfileCheckins && profileId !== 'anonymous'
      ? await readMatchingJsonLines(
          CHECKIN_LOG_PATH,
          (item) => sanitizePublicId(item?.routeId) === routeId && normalizeProfileId(item?.profileId) === profileId,
          5000,
          100000
        )
      : [];
  const context = await buildOpsAuditContext();
  const verifiedCheckins = persistedCheckins
    .map((item) => applyCheckinOpsOverlay(item, context))
    .filter(isPublicTrustEligibleCheckin)
    .map((item) => ({ ...publicCheckinForReview(item), sourceCheckinId: sanitizePublicId(item.id) }));
  const checkins = latestCheckinsByStop(verifiedCheckins);
  const executionStops = normalizeReviewExecutionStops(input?.executionStops, routebook);
  const feedbackCheckins = checkins.filter((item) => item.worth !== '跳过' && item.status !== 'skipped');
  const validCheckins = feedbackCheckins.filter((item) => item.arrival?.valid === true);
  // 完成率分母固定用主线站点数，防止客户端裁剪 executionStops 伪造 100% 完成率。
  const routeStopCount = routebook.stops.length;
  const reviewId = cryptoRandomId();
  return {
    id: reviewId,
    publicId: reviewId,
    routebookId: routeId,
    profileId,
    routebook: publicRoutebookView(routebook),
    executionStops,
    checkins,
    selfReportedCheckinCount: 0,
    stats: {
      completionRate: routeStopCount ? Math.min(100, Math.round((validCheckins.length / routeStopCount) * 100)) : 0,
      checkinCount: checkins.length,
      feedbackCount: feedbackCheckins.length,
      validArrivalCount: validCheckins.length,
      lowConfidenceArrivalCount: feedbackCheckins.filter((item) => ['weak', 'invalid'].includes(item.arrivalConfidence || item.arrival?.confidence)).length,
      pitfallCount: checkins.filter((item) => item.worth === '踩坑' || item.pitfall).length
    },
    createdAt: new Date().toISOString()
  };
}

// Later entries win, matching the previous `new Map(entries)` semantics; blank keys are skipped.
function mapByTrimmedKey(items, keyOf) {
  const map = new Map();
  for (const item of items) {
    const key = String(keyOf(item) ?? '').trim();
    if (key) map.set(key, item);
  }
  return map;
}

function normalizeReviewExecutionStops(input, routebook) {
  if (!Array.isArray(input) || !input.length) return [];
  const allowedStops = [...(routebook?.stops ?? []), ...(routebook?.variants ?? []).flatMap((variant) => variant?.stops ?? [])];
  const byId = mapByTrimmedKey(allowedStops, (stop) => stop?.id);
  const byName = mapByTrimmedKey(allowedStops, (stop) => stop?.name);
  const seen = new Set();
  const output = [];
  for (const candidate of input.slice(0, MAX_ROUTEBOOK_STOPS)) {
    const id = String(candidate?.id ?? '').trim();
    const name = String(candidate?.name ?? '').trim();
    const canonical = byId.get(id) ?? byName.get(name);
    if (!canonical) continue;
    const key = String(canonical.id ?? canonical.name ?? '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push({
      ...publicRoutebookStop(canonical),
      day: truncateString(candidate?.day || canonical.day, 24),
      time: truncateString(candidate?.time || canonical.time, 24),
      tripReplacementFor: truncateString(candidate?.tripReplacementFor, 80),
      tripStatus: ['pending', 'visited', 'skipped'].includes(candidate?.tripStatus) ? candidate.tripStatus : '',
      photoId: normalizeCheckinPhotoId(candidate?.photoId)
    });
  }
  return output;
}

export async function reviewIsStillPublic(review) {
  const routeId = sanitizePublicId(review?.routebookId || review?.routebook?.publicId || review?.routebook?.id);
  if (!routeId) return isPublicRoutebook(review?.routebook);
  const currentRoutebook = await getResolvableRoutebook(routeId);
  return isPublicRoutebook(currentRoutebook);
}

// Re-project append-only review snapshots against current moderation. Historical
// rows without sourceCheckinId use only the same owner+route and matching stop.
export async function applyOpsAuditsToReview(review, context = null) {
  if (!review) return review;
  context ??= await buildOpsAuditContext();
  const suppressedIds = new Set(
    [...context.checkinOverlays.values()].filter((event) => isOpsSuppressedCheckin({ opsDisposition: event.state })).map((event) => event.entityId)
  );
  if (!suppressedIds.size) return review;
  const routeId = sanitizePublicId(review.routebookId || review.routebook?.publicId || review.routebook?.id);
  const profileId = normalizeProfileId(review.profileId);
  const legacySources =
    profileId && profileId !== 'anonymous' && routeId
      ? await readMatchingJsonLines(
          CHECKIN_LOG_PATH,
          (item) => suppressedIds.has(item.id) && normalizeProfileId(item.profileId) === profileId && sanitizePublicId(item.routeId) === routeId,
          Number.POSITIVE_INFINITY,
          Number.POSITIVE_INFINITY
        )
      : [];
  const removed = [];
  const checkins = (review.checkins ?? []).filter((item) => {
    const id = sanitizePublicId(item.sourceCheckinId);
    const suppressed = id ? suppressedIds.has(id) : legacySources.some((source) => reviewCheckinMatchesSource(item, source));
    if (suppressed) removed.push(item);
    return !suppressed;
  });
  const feedback = checkins.filter((item) => item.worth !== '跳过' && item.status !== 'skipped');
  const valid = feedback.filter((item) => item.arrival?.valid === true);
  const stopCount = review.routebook?.stops?.length ?? 0;
  return {
    ...review,
    checkins,
    executionStops: (review.executionStops ?? []).map((stop) =>
      removed.some((item) => reviewCheckinMatchesSource({ stopId: stop.id, stopName: stop.name }, item) || (stop.photoId && stop.photoId === item.photoId))
        ? { ...stop, tripStatus: 'pending', tripReplacementFor: '', photoId: '' }
        : stop
    ),
    stats: {
      ...review.stats,
      completionRate: stopCount ? Math.min(100, Math.round((valid.length / stopCount) * 100)) : 0,
      checkinCount: checkins.length,
      feedbackCount: feedback.length,
      validArrivalCount: valid.length,
      lowConfidenceArrivalCount: feedback.filter((item) => ['weak', 'invalid'].includes(item.arrivalConfidence || item.arrival?.confidence)).length,
      pitfallCount: checkins.filter((item) => item.worth === '踩坑' || item.pitfall).length
    }
  };
}

function reviewCheckinMatchesSource(review, source) {
  if (review.status && source.status && review.status !== source.status) return false;
  if (review.poiId && source.poiId && review.poiId === source.poiId) return true;
  const keys = new Set([review.localStopKey, review.stopId].filter(Boolean).map(String));
  if ([source.localStopKey, source.stopId].some((key) => key && keys.has(String(key)))) return true;
  return Boolean(review.stopName && source.stopName && review.stopName === source.stopName);
}

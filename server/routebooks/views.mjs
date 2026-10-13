// Public (redacted) views of routebooks, reviews and trust data.
import { safeSourceUrl } from '../lib/urls.mjs';
import { PUBLIC_ROUTE_STATUSES, PUBLIC_TRUST_SAMPLE_THRESHOLD, MAX_ROUTEBOOK_STOPS } from '../config/index.mjs';
import { clampNumber, normalizeCityName, positiveInteger, sanitizePublicId, truncateString } from '../lib/util.mjs';
import { safeTokenEqual } from '../auth/tokens.mjs';
import { normalizeCreator } from './normalize.mjs';
import { normalizeCheckinPhotoId } from '../photos/checkin-photos.mjs';
import { normalizeStoredRouteLegs } from '../routing/provenance.mjs';
import { aigcMetadata } from '../../src/lib/aigc.js';
import { isModerationWithheld } from '../moderation/index.mjs';

export function isPublicRoutebook(routebook) {
  if (!PUBLIC_ROUTE_STATUSES.has(routebook?.publishStatus || 'draft')) return false;
  // A published routebook flagged by moderation stays private until ops approve it.
  return !isModerationWithheld('routebook', sanitizePublicId(routebook?.publicId || routebook?.id));
}

/**
 * Unlisted friend-link access: the routebook is not archived, not withheld by
 * moderation, and the caller presents the server-generated key.
 * @param {Record<string, any> | null | undefined} routebook
 * @param {unknown} key
 */
export function hasFriendLinkAccess(routebook, key) {
  const stored = routebook?.friendLink?.key;
  const provided = String(key ?? '');
  if (!stored || !/^[a-f0-9]{32}$/.test(provided) || (routebook?.publishStatus || 'draft') === 'archived') return false;
  if (isModerationWithheld('routebook', sanitizePublicId(routebook.publicId || routebook.id))) return false;
  return safeTokenEqual(provided, stored);
}

function hasPublicTrustSamples(sampleCount) {
  return clampNumber(sampleCount, 0, 1000000, 0) >= PUBLIC_TRUST_SAMPLE_THRESHOLD;
}

function hasPublicRouteTrustScore(meta = {}) {
  return hasPublicTrustSamples(meta?.sampleCount) && meta?.source === 'verified-feedback' && isValidTrustDisplayScore(meta?.displayScore);
}

function isValidTrustDisplayScore(value) {
  const present = typeof value === 'number' || (typeof value === 'string' && value.trim() !== '');
  if (!present) return false;
  const score = Number(value);
  return Number.isFinite(score) && score >= 0 && score <= 100;
}

export function publicRoutebookView(routebook) {
  if (!routebook) return null;
  const routeTrustVisible = hasPublicRouteTrustScore(routebook.trustMeta);
  const publicRouteTrustScore = routeTrustVisible ? clampNumber(routebook.trustMeta.displayScore, 0, 100, 0) : null;
  return {
    id: sanitizePublicId(routebook.id || routebook.publicId),
    publicId: sanitizePublicId(routebook.publicId || routebook.id),
    title: truncateString(routebook.title, 80),
    summary: truncateString(routebook.summary, 220),
    city: routebook.city ? normalizeCityName(routebook.city) : '',
    trustScore: publicRouteTrustScore,
    trustMeta: publicTrustMeta(routebook.trustMeta),
    // Only the fallback marker (「本次由备用模型生成」); model / base URL stay private.
    ...(['fast', 'deep'].includes(routebook.provider?.fellBackFrom) ? { provider: { fellBackFrom: routebook.provider.fellBackFrom } } : {}),
    days: Array.isArray(routebook.days)
      ? routebook.days
          .map((day) => truncateString(day, 24))
          .filter(Boolean)
          .slice(0, 10)
      : [],
    stops: Array.isArray(routebook.stops) ? routebook.stops.slice(0, MAX_ROUTEBOOK_STOPS).map(publicRoutebookStop) : [],
    routeLegs: publicRouteLegs(routebook),
    assets: Array.isArray(routebook.assets)
      ? routebook.assets.slice(0, 12).map((item) => ({
          label: truncateString(item?.label, 30),
          type: truncateString(item?.type, 24),
          confidence: item?.confidence == null ? null : clampNumber(item.confidence, 0, 100, 0)
        }))
      : [],
    validations: Array.isArray(routebook.validations)
      ? routebook.validations.slice(0, 8).map((item) => ({
          id: sanitizePublicId(item?.id),
          label: truncateString(item?.label, 60),
          state: truncateString(item?.state, 40),
          detail: truncateString(item?.detail, 220)
        }))
      : [],
    metrics: Array.isArray(routebook.metrics)
      ? routebook.metrics.slice(0, 10).map((item) => ({
          label: truncateString(item?.label, 60),
          value: !routeTrustVisible && ['站点均分', '资料核验分'].includes(item?.label) ? '待验证' : truncateString(item?.value, 80)
        }))
      : [],
    feedbackSummary: publicFeedbackSummary(routebook.feedbackSummary),
    variants: Array.isArray(routebook.variants)
      ? routebook.variants.slice(0, 8).map((variant) => publicRouteVariant({ ...variant, constraints: routebook.constraints }))
      : [],
    activeVariantId: sanitizePublicId(routebook.activeVariantId),
    creator: publicCreatorView(routebook.creator),
    publishStatus: PUBLIC_ROUTE_STATUSES.has(routebook.publishStatus) ? routebook.publishStatus : 'published',
    sourceAuthorization: truncateString(routebook.sourceAuthorization || routebook.creator?.sourceAuthorization, 40),
    copyCount: clampNumber(routebook.copyCount, 0, 1000000, 0),
    // Implicit AIGC label (metadata), derived from the stored routebook, never from the client.
    aigc: aigcMetadata(routebook),
    schemaVersion: positiveInteger(routebook.schemaVersion, 1),
    version: positiveInteger(routebook.version, 1),
    parentVersion: positiveInteger(routebook.parentVersion),
    createdAt: truncateString(routebook.createdAt, 60),
    publishedAt: truncateString(routebook.publishedAt, 60),
    archivedAt: truncateString(routebook.archivedAt, 60),
    updatedAt: truncateString(routebook.updatedAt, 60)
  };
}

const PUBLIC_STOP_ORIGINS = new Set(['user-guide', 'imported-source', 'user-added', 'model', 'unknown']);

// matchedText/proof are omitted: matchedText quotes the owner's private guide text.
function publicStopProvenance(provenance) {
  if (!provenance || typeof provenance !== 'object') return null;
  return {
    origin: PUBLIC_STOP_ORIGINS.has(provenance.origin) ? provenance.origin : 'unknown',
    reviewedPoi: provenance.reviewedPoi === true,
    verifiedFactCount: clampNumber(provenance.verifiedFactCount, 0, 20, 0)
  };
}

function publicCostInfo(costInfo) {
  if (!costInfo || typeof costInfo !== 'object') return null;
  const money = (value) => (value == null || !Number.isFinite(Number(value)) ? null : clampNumber(value, 0, 1000000, 0));
  return {
    amount: money(costInfo.amount),
    min: money(costInfo.min),
    max: money(costInfo.max),
    currency: truncateString(costInfo.currency, 8),
    unit: truncateString(costInfo.unit, 24),
    per: truncateString(costInfo.per, 24),
    free: costInfo.free === true,
    reservationRequired: costInfo.reservationRequired === true,
    known: costInfo.known === true,
    source: truncateString(costInfo.source, 32),
    text: truncateString(costInfo.text, 32)
  };
}

export function publicRoutebookStop(stop = {}) {
  const poiTrust = publicPoiTrust(stop.poiTrust);
  return {
    id: typeof stop.id === 'number' ? stop.id : sanitizePublicId(stop.id),
    poiId: sanitizePublicId(stop.poiId),
    day: truncateString(stop.day, 24),
    time: truncateString(stop.time, 24),
    name: truncateString(stop.name, 48),
    area: truncateString(stop.area, 40),
    stay: truncateString(stop.stay, 24),
    cost: truncateString(stop.cost, 32),
    verify: truncateString(stop.verify, 120),
    risk: truncateString(stop.risk, 120),
    // Model self-scores are no longer part of the trust model; legacy values are never exposed.
    score: null,
    provenance: publicStopProvenance(stop.provenance),
    costInfo: publicCostInfo(stop.costInfo),
    verifiedPrice: stop.verifiedPrice?.text
      ? {
          text: truncateString(stop.verifiedPrice.text, 80),
          verifiedAt: truncateString(stop.verifiedPrice.verifiedAt, 40),
          expiresAt: truncateString(stop.verifiedPrice.expiresAt, 40),
          source: { label: truncateString(stop.verifiedPrice.source?.label, 80), url: safeSourceUrl(stop.verifiedPrice.source?.url) || '' },
          costInfo: publicCostInfo(stop.verifiedPrice.costInfo)
        }
      : null,
    lat: Number.isFinite(Number(stop.lat)) ? Number(stop.lat) : null,
    lng: Number.isFinite(Number(stop.lng)) ? Number(stop.lng) : null,
    geoConfidence: stop.geoConfidence == null ? null : clampNumber(stop.geoConfidence, 0, 100, 0),
    coordinateSystem: truncateString(stop.coordinateSystem, 20),
    coordinateSource: truncateString(stop.coordinateSource, 40),
    coordinatePrecision: truncateString(stop.coordinatePrecision, 40),
    coordinateRadiusMeters: stop.coordinateRadiusMeters == null ? null : clampNumber(stop.coordinateRadiusMeters, 0, 1000000, 0),
    navigationDisabled: stop.navigationDisabled === true,
    transportMode: truncateString(stop.transportMode, 24),
    poiTrust,
    sourceEvidence: Array.isArray(stop.sourceEvidence)
      ? stop.sourceEvidence
          .filter((item) => !item?.authorizationStatus || ['authorized-public', 'not-applicable'].includes(item.authorizationStatus))
          .slice(0, 5)
          .map((item) => ({
            id: sanitizePublicId(item?.id),
            sourceId: sanitizePublicId(item?.sourceId),
            type: truncateString(item?.type, 32),
            label: truncateString(item?.label, 80),
            platform: truncateString(item?.platform, 40),
            trustScore: item?.trustScore == null ? null : clampNumber(item.trustScore, 0, 100, 0),
            checkedAt: truncateString(item?.checkedAt, 60)
          }))
      : [],
    facts: Array.isArray(stop.facts)
      ? stop.facts.slice(0, 8).map((item) => ({
          id: sanitizePublicId(item?.id),
          field: truncateString(item?.field, 40),
          value: truncateString(item?.value, 180),
          confidence: item?.confidence == null ? null : clampNumber(item.confidence, 0, 100, 0),
          sourceLabel: truncateString(item?.sourceLabel, 80),
          sourceType: truncateString(item?.sourceType, 32),
          status: truncateString(item?.status, 24),
          checkedAt: truncateString(item?.checkedAt, 60)
        }))
      : []
  };
}

function publicRouteVariant(variant = {}) {
  return {
    id: sanitizePublicId(variant.id),
    mode: truncateString(variant.mode, 24),
    label: truncateString(variant.label, 40),
    summary: truncateString(variant.summary, 160),
    days: Array.isArray(variant.days)
      ? variant.days
          .map((day) => truncateString(day, 24))
          .filter(Boolean)
          .slice(0, 10)
      : [],
    stops: Array.isArray(variant.stops) ? variant.stops.slice(0, MAX_ROUTEBOOK_STOPS).map(publicRoutebookStop) : [],
    routeLegs: publicRouteLegs(variant),
    trustScore: null,
    metrics: Array.isArray(variant.metrics)
      ? variant.metrics.slice(0, 10).map((item) => ({
          label: truncateString(item?.label, 60),
          value: ['站点均分', '资料核验分'].includes(item?.label) ? '待验证' : truncateString(item?.value, 80)
        }))
      : [],
    validations: Array.isArray(variant.validations)
      ? variant.validations.slice(0, 8).map((item) => ({
          id: sanitizePublicId(item?.id),
          label: truncateString(item?.label, 60),
          state: truncateString(item?.state, 40),
          detail: truncateString(item?.detail, 220)
        }))
      : [],
    createdAt: truncateString(variant.createdAt, 60),
    updatedAt: truncateString(variant.updatedAt, 60)
  };
}

function publicRouteLegs(routebook) {
  return normalizeStoredRouteLegs(routebook?.routeLegs, routebook?.stops, routebook?.constraints?.transport).map((leg) => {
    const result = /** @type {Record<string, any>} */ ({ ...leg });
    delete result.proof;
    return result;
  });
}

function publicCreatorView(creator = {}) {
  const normalized = normalizeCreator(creator);
  return {
    id: normalized.id,
    name: normalized.name,
    avatar: normalized.avatar,
    bio: normalized.bio,
    sourceAuthorization: normalized.sourceAuthorization
  };
}

/** @param {any} [meta] */
function publicTrustMeta(meta = {}) {
  if (!meta || typeof meta !== 'object') return null;
  const scoreVisible = hasPublicRouteTrustScore(meta);
  return {
    predictionScore: scoreVisible && meta.predictionScore != null ? clampNumber(meta.predictionScore, 0, 100, 0) : null,
    feedbackScore: scoreVisible && meta.feedbackScore != null ? clampNumber(meta.feedbackScore, 0, 100, 0) : null,
    displayScore: scoreVisible ? clampNumber(meta.displayScore, 0, 100, 0) : null,
    source: truncateString(meta.source, 24),
    label: truncateString(meta.label, 60),
    sampleCount: clampNumber(meta.sampleCount, 0, 1000000, 0),
    aiWeight: scoreVisible && meta.aiWeight != null ? clampNumber(meta.aiWeight, 0, 1, 0) : null,
    feedbackWeight: scoreVisible && meta.feedbackWeight != null ? clampNumber(meta.feedbackWeight, 0, 1, 0) : null,
    latestVerifiedAt: truncateString(meta.latestVerifiedAt, 60)
  };
}

/** @param {any} [summary] */
function publicFeedbackSummary(summary = {}) {
  if (!summary || typeof summary !== 'object') return null;
  return {
    sampleCount: clampNumber(summary.sampleCount, 0, 1000000, 0),
    attestedCheckinCount: clampNumber(summary.attestedCheckinCount, 0, 1000000, 0),
    validArrivalCount: clampNumber(summary.validArrivalCount, 0, 1000000, 0),
    lowConfidenceArrivalCount: clampNumber(summary.lowConfidenceArrivalCount, 0, 1000000, 0),
    feedbackCount: clampNumber(summary.feedbackStopCount ?? summary.feedbackCount, 0, 1000000, 0),
    feedbackStopCount: clampNumber(summary.feedbackStopCount ?? summary.feedbackCount, 0, 1000000, 0),
    pitfallCount: clampNumber(summary.pitfallCount, 0, 1000000, 0),
    pitfallRate: summary.pitfallRate == null ? null : clampNumber(summary.pitfallRate, 0, 100, 0),
    correctionCount: clampNumber(summary.correctionCount, 0, 1000000, 0),
    completionRate: summary.completionRate == null ? null : clampNumber(summary.completionRate, 0, 100, 0),
    // rank20④：旧并集完成率口径（coverageRate）进入公开白名单。
    coverageRate: summary.coverageRate == null ? null : clampNumber(summary.coverageRate, 0, 100, 0),
    latestFeedbackAt: truncateString(summary.latestFeedbackAt, 60)
  };
}

/** @param {any} [poiTrust] */
function publicPoiTrust(poiTrust = {}) {
  if (!poiTrust || typeof poiTrust !== 'object') return null;
  const scoreVisible = hasPublicTrustSamples(poiTrust.sampleCount) && poiTrust.score != null && Number.isFinite(Number(poiTrust.score));
  const parsedLatestVerifiedAt = Date.parse(poiTrust.latestVerifiedAt ?? '');
  const derivedFreshnessDays = Number.isFinite(parsedLatestVerifiedAt)
    ? Math.max(0, Math.floor((Date.now() - parsedLatestVerifiedAt) / (24 * 60 * 60 * 1000)))
    : null;
  const sampleCount = clampNumber(poiTrust.sampleCount, 0, 1000000, 0);
  return {
    score: scoreVisible ? clampNumber(poiTrust.score, 0, 100, 0) : null,
    scope: truncateString(poiTrust.scope, 32),
    sampleCount,
    validArrivals: clampNumber(poiTrust.validArrivals, 0, 1000000, 0),
    pitfallRate: poiTrust.pitfallRate == null ? null : clampNumber(poiTrust.pitfallRate, 0, 100, 0),
    // rank20①：打卡反哺的经验聚合字段（人群构成/排队/花费/拥挤/最新反馈）。
    audienceBreakdown: Array.isArray(poiTrust.audienceBreakdown)
      ? poiTrust.audienceBreakdown
          .slice(0, 6)
          .map((item) => ({
            label: truncateString(item?.label, 80),
            count: clampNumber(item?.count, 0, 1000000, 0),
            share: clampNumber(Math.round(Number(item?.share)), 0, 100, 0)
          }))
          .filter((item) => item.label)
      : [],
    queueMinutesMedian: poiTrust.queueMinutesMedian == null ? null : clampNumber(poiTrust.queueMinutesMedian, 0, 100000, 0),
    costMedian: poiTrust.costMedian == null ? null : clampNumber(poiTrust.costMedian, 0, 10000000, 0),
    crowdLevel: truncateString(poiTrust.crowdLevel, 30),
    latestFeedbackAt: truncateString(poiTrust.latestFeedbackAt || poiTrust.latestVerifiedAt, 60),
    recentCorrectionCount: clampNumber(poiTrust.recentCorrectionCount, 0, 1000000, 0),
    latestVerifiedAt: truncateString(poiTrust.latestVerifiedAt, 60),
    freshnessDays: poiTrust.freshnessDays == null ? derivedFreshnessDays : clampNumber(poiTrust.freshnessDays, 0, 36500, 0),
    trustState: scoreVisible ? 'verified' : sampleCount > 0 ? 'collecting' : 'pending',
    label: truncateString(poiTrust.label, 60)
  };
}

export function publicReviewView(review) {
  if (!review) return null;
  return {
    publicId: sanitizePublicId(review.publicId || review.id),
    routebookId: sanitizePublicId(review.routebookId || review.routebook?.publicId || review.routebook?.id),
    routebook: publicReviewRoutebookView(review.routebook),
    executionStops: Array.isArray(review.executionStops) ? review.executionStops.slice(0, MAX_ROUTEBOOK_STOPS).map(publicReviewExecutionStop) : [],
    checkins: Array.isArray(review.checkins)
      ? review.checkins.slice(0, MAX_ROUTEBOOK_STOPS).map((item) => {
          const view = publicCheckinForReview(item);
          // Free text held by moderation is withheld; the structured check-in stays.
          if (!isModerationWithheld('checkin', sanitizePublicId(item?.sourceCheckinId))) return view;
          return { ...view, comment: '', pitfall: '', queue: '', cost: '', textWithheld: true };
        })
      : [],
    stats: publicReviewStats(review.stats)
  };
}

function publicReviewRoutebookView(routebook = {}) {
  return {
    id: sanitizePublicId(routebook.id || routebook.publicId),
    publicId: sanitizePublicId(routebook.publicId || routebook.id),
    title: truncateString(routebook.title, 80),
    city: routebook.city ? normalizeCityName(routebook.city) : '',
    stops: Array.isArray(routebook.stops) ? routebook.stops.slice(0, MAX_ROUTEBOOK_STOPS).map(publicReviewRouteStop) : []
  };
}

function publicReviewRouteStop(stop = {}) {
  return {
    id: typeof stop.id === 'number' ? stop.id : sanitizePublicId(stop.id),
    day: truncateString(stop.day, 24),
    time: truncateString(stop.time, 24),
    name: truncateString(stop.name, 48)
  };
}

function publicReviewExecutionStop(stop = {}) {
  return {
    ...publicReviewRouteStop(stop),
    tripReplacementFor: truncateString(stop.tripReplacementFor, 80),
    tripStatus: ['pending', 'visited', 'skipped'].includes(stop.tripStatus) ? stop.tripStatus : '',
    // rank13④：执行站点也透出照片证据 ID，供回顾页照片墙渲染。
    photoId: normalizeCheckinPhotoId(stop.photoId)
  };
}

function publicReviewStats(stats = {}) {
  return {
    completionRate: clampNumber(stats.completionRate, 0, 100, 0),
    checkinCount: clampNumber(stats.checkinCount, 0, MAX_ROUTEBOOK_STOPS, 0),
    feedbackCount: clampNumber(stats.feedbackCount, 0, MAX_ROUTEBOOK_STOPS, 0),
    validArrivalCount: clampNumber(stats.validArrivalCount, 0, MAX_ROUTEBOOK_STOPS, 0),
    lowConfidenceArrivalCount: clampNumber(stats.lowConfidenceArrivalCount, 0, MAX_ROUTEBOOK_STOPS, 0),
    pitfallCount: clampNumber(stats.pitfallCount, 0, MAX_ROUTEBOOK_STOPS, 0)
  };
}

export function publicCheckinForReview(item = {}) {
  const arrival =
    item?.arrival && typeof item.arrival === 'object'
      ? {
          valid: item.arrival.valid === true,
          confidence: truncateString(item.arrival.confidence || item.arrivalConfidence, 24),
          label: truncateString(item.arrival.label, 40)
        }
      : null;
  return {
    localStopKey: truncateString(item?.localStopKey, 120),
    stopId: truncateString(item?.stopId, 80),
    poiId: sanitizePublicId(item?.poiId),
    stopName: truncateString(item?.stopName, 80),
    status: truncateString(item?.status, 24),
    worth: truncateString(item?.worth, 30),
    queue: truncateString(item?.queue, 40),
    cost: truncateString(item?.cost, 40),
    crowd: truncateString(item?.crowd, 30),
    comment: truncateString(item?.comment, 300),
    pitfall: truncateString(item?.pitfall, 240),
    // rank13④：照片证据 ID 随回顾透出（照片本体经 GET /api/checkin-photos/:id 提供）。
    photoId: normalizeCheckinPhotoId(item?.photoId),
    arrivalConfidence: arrival?.confidence || '',
    arrival
  };
}

// Feedback aggregation and trust scores for routebooks and stops.
import {
  CHECKIN_LOG_PATH,
  EXPOSURE_LOG_PATH,
  POI_CORRECTION_LOG_PATH,
  REVIEW_LOG_PATH,
  ROUTEBOOK_LOG_PATH,
  PUBLIC_TRUST_SAMPLE_THRESHOLD,
  TRAVEL_DAY_TIME_ZONE,
  TRUST_FEEDBACK_SAMPLE_TARGET,
  POI_FEEDBACK_WINDOW_DAYS
} from '../config/index.mjs';
import { readRecentJsonlRows, collectMatchingRows, readMatchingJsonLines } from '../storage/jsonl.mjs';
import { ROUTEBOOK_HISTORY_PROJECTION } from '../storage/projections.mjs';
import { clampNumber, sanitizePublicId, truncateString } from '../lib/util.mjs';
import { normalizeProfileId } from '../auth/tokens.mjs';
import {
  displayableProcessLogs,
  normalizeStopEvidence,
  normalizeStopFacts,
  normalizeImportedSources,
  systemMetrics,
  systemValidations
} from '../routebooks/normalize.mjs';
import { routebookEvidence } from './provenance.mjs';
import { TRUST_SCORE_EXPLANATION } from '../../src/lib/trustSignals.js';
import {
  checkinEventTime,
  checkinStopKey,
  isEligibleTrustCheckin,
  isPublicTrustEligibleCheckin,
  latestTrustedCheckinsByProfileAndPoi,
  latestTrustedCheckinsByProfileAndStop,
  localDateForTimestamp,
  poiCheckinKey
} from './checkins.mjs';
import { routebookCopyCount } from '../routebooks/copies.mjs';
import { isHoursOrClosureCorrection, listPoiKnowledge } from '../poi/knowledge.mjs';
import { resolvePoiId, normalizePoiName } from '../poi/catalog.mjs';
import { applyCheckinOpsOverlay, buildOpsAuditContext } from '../ops/audit.mjs';
import { applyImportSourceOpsToRoutebook } from '../ops/sources.mjs';
import { importSourceId } from '../ops/source-identity.mjs';

// rank23①：GET /api/routebooks 列表等批量路径可先 buildRouteFeedbackContext() 一次性
// 读齐 5 份 JSONL，再把同一份行数组传给每次 buildFeedbackSummary 复用，避免逐路书重扫。
const FEEDBACK_SCAN_MATCH_LIMIT = 5000;
const FEEDBACK_SCAN_WINDOW = 100000;

export async function buildRouteFeedbackContext() {
  const [rawCheckins, corrections, reviews, routebookHistory, exposures, opsAuditContext] = await Promise.all([
    readRecentJsonlRows(CHECKIN_LOG_PATH, FEEDBACK_SCAN_WINDOW),
    readRecentJsonlRows(POI_CORRECTION_LOG_PATH, FEEDBACK_SCAN_WINDOW),
    readRecentJsonlRows(REVIEW_LOG_PATH, FEEDBACK_SCAN_WINDOW),
    readRecentJsonlRows(ROUTEBOOK_LOG_PATH, FEEDBACK_SCAN_WINDOW, ROUTEBOOK_HISTORY_PROJECTION),
    readRecentJsonlRows(EXPOSURE_LOG_PATH, FEEDBACK_SCAN_WINDOW),
    buildOpsAuditContext()
  ]);
  const checkins = rawCheckins.map((item) => applyCheckinOpsOverlay(item, opsAuditContext));
  return { checkins, corrections, reviews, routebookHistory, exposures, opsAuditContext };
}

async function buildFeedbackSummary(routebook, feedbackContext = null) {
  const routeTitle = String(routebook?.title ?? '');
  const city = String(routebook?.city ?? '');
  const routeId = sanitizePublicId(routebook?.publicId || routebook?.id);
  const matchesRouteCheckin = (item) =>
    routeId
      ? sanitizePublicId(item?.routeId) === routeId
      : (!routeTitle || item?.routeTitle === routeTitle) && (!city || item?.city === city) && !item?.routeId;
  const globalEligiblePredicate = (item) => isEligibleTrustCheckin(item) && item?.serverResolvedStop === true;
  const correctionPredicate = (item) => (!routeTitle || item?.routeTitle === routeTitle) && (!city || item?.city === city);
  const reviewPredicate = (item) =>
    routeId
      ? sanitizePublicId(item?.routebookId || item?.routebook?.publicId || item?.routebook?.id) === routeId
      : item?.routebook?.title === routeTitle && (!city || item?.routebook?.city === city);
  const historyPredicate = (item) =>
    (routeId && sanitizePublicId(item?.publicId || item?.id) === routeId) || (!routeId && item?.title === routeTitle && item?.city === city);
  const exposurePredicate = (item) => (routeId && sanitizePublicId(item?.routeId || item?.itemId) === routeId) || (!routeId && item?.routeTitle === routeTitle);
  // 按 routeId/routeTitle 谓词精确反扫（匹配窗口 5000 行），替代全局尾窗 + filter：
  // 旧路径下热门路线会把冷路线的历史反馈挤出统计窗口。传入共享上下文时改为
  // 对同一份内存行数组过滤，谓词与窗口口径不变。
  const [rawMatchedCheckins, rawGlobalEligibleCheckins, corrections, matchedReviews, matchedHistory, matchedExposures] = feedbackContext
    ? [
        collectMatchingRows(feedbackContext.checkins, matchesRouteCheckin, FEEDBACK_SCAN_MATCH_LIMIT),
        collectMatchingRows(feedbackContext.checkins, globalEligiblePredicate, FEEDBACK_SCAN_MATCH_LIMIT),
        collectMatchingRows(feedbackContext.corrections, correctionPredicate, FEEDBACK_SCAN_MATCH_LIMIT),
        collectMatchingRows(feedbackContext.reviews, reviewPredicate, FEEDBACK_SCAN_MATCH_LIMIT),
        collectMatchingRows(feedbackContext.routebookHistory, historyPredicate, FEEDBACK_SCAN_MATCH_LIMIT),
        collectMatchingRows(feedbackContext.exposures, exposurePredicate, FEEDBACK_SCAN_MATCH_LIMIT)
      ]
    : await Promise.all([
        readMatchingJsonLines(CHECKIN_LOG_PATH, matchesRouteCheckin, FEEDBACK_SCAN_MATCH_LIMIT, FEEDBACK_SCAN_WINDOW),
        readMatchingJsonLines(CHECKIN_LOG_PATH, globalEligiblePredicate, FEEDBACK_SCAN_MATCH_LIMIT, FEEDBACK_SCAN_WINDOW),
        readMatchingJsonLines(POI_CORRECTION_LOG_PATH, correctionPredicate, FEEDBACK_SCAN_MATCH_LIMIT, FEEDBACK_SCAN_WINDOW),
        readMatchingJsonLines(REVIEW_LOG_PATH, reviewPredicate, FEEDBACK_SCAN_MATCH_LIMIT, FEEDBACK_SCAN_WINDOW),
        readMatchingJsonLines(ROUTEBOOK_LOG_PATH, historyPredicate, FEEDBACK_SCAN_MATCH_LIMIT, FEEDBACK_SCAN_WINDOW, ROUTEBOOK_HISTORY_PROJECTION),
        readMatchingJsonLines(EXPOSURE_LOG_PATH, exposurePredicate, FEEDBACK_SCAN_MATCH_LIMIT, FEEDBACK_SCAN_WINDOW)
      ]);
  const opsAuditContext = feedbackContext?.opsAuditContext ?? (await buildOpsAuditContext());
  const matchedCheckins = rawMatchedCheckins.map((item) => applyCheckinOpsOverlay(item, opsAuditContext));
  const globalEligibleCheckins = rawGlobalEligibleCheckins.map((item) => applyCheckinOpsOverlay(item, opsAuditContext)).filter(isEligibleTrustCheckin);
  const trustedRouteStops = [...(routebook?.stops ?? []), ...(routebook?.variants ?? []).flatMap((variant) => variant?.stops ?? [])];
  const profileAttestedCheckins = matchedCheckins.filter(
    (item) => isPublicTrustEligibleCheckin(item) && trustedRouteStops.some((stop) => isSameCheckinStop(stop, item))
  );
  const attestedCheckins = latestTrustedCheckinsByProfileAndStop(profileAttestedCheckins);
  const eligibleTrustCheckins = latestTrustedCheckinsByProfileAndStop(profileAttestedCheckins.filter(isEligibleTrustCheckin));
  const globalPoiCheckins = latestTrustedCheckinsByProfileAndPoi(globalEligibleCheckins);
  const verifiedArrivalCheckins = eligibleTrustCheckins;
  const verifiedProfileCount = new Set(verifiedArrivalCheckins.map((item) => normalizeProfileId(item.profileId)).filter((id) => id && id !== 'anonymous')).size;
  const attestedProfileCount = new Set(
    verifiedArrivalCheckins
      .filter((item) => item.trustState === 'profile-attested')
      .map((item) => normalizeProfileId(item.profileId))
      .filter((id) => id && id !== 'anonymous')
  ).size;
  const matchedCorrections = corrections;
  const shareExposureCount = matchedExposures.filter((item) => item.itemType === 'routebook' || item.surface === 'public-share').length;
  const editCount = matchedHistory.filter((item) => item.provider?.editedAt || item.activeVariantId).length;
  const latestVerifiedAt =
    verifiedArrivalCheckins
      .map((item) => item.createdAt ?? item.time)
      .filter(Boolean)
      .sort()
      .at(-1) ?? null;
  const validArrivalCount = verifiedArrivalCheckins.length;
  const lowConfidenceArrivalCount = attestedCheckins.filter((item) => ['weak', 'invalid'].includes(item.arrival?.confidence)).length;
  const uniqueVisitedStops = new Set(eligibleTrustCheckins.map(checkinStopKey).filter(Boolean));
  // rank27：与 uniqueVisitedStops 完全同口径，复用同一个 Set 不再重复计算。
  const feedbackStopCount = uniqueVisitedStops.size;
  const pitfallCount = eligibleTrustCheckins.filter((item) => item.worth === '踩坑' || item.pitfall).length;
  const positiveCount = eligibleTrustCheckins.filter((item) => item.worth === '值得').length;
  // skip/replaced 计数不能基于 eligibleTrustCheckins（其要求 status==='visited'，
  // 结构上恒为 0）；改按 profile+stop 最新态（attestedCheckins）统计终态。
  const skipCount = attestedCheckins.filter((item) => item?.status === 'skipped').length;
  const replacedCount = attestedCheckins.filter((item) => item?.status === 'replaced').length;
  const completeFeedbackCount = eligibleTrustCheckins.filter(
    (item) => item.worth && item.queue && item.cost && item.crowd && (item.comment || item.pitfall || item.arrival?.valid)
  ).length;
  const routeStopCount = Array.isArray(routebook?.stops) ? routebook.stops.length : 0;
  // 完成率改为按 profile 个体完成率取平均：跨用户站点并集会把 3 个各走 1 站的
  // 用户算成 3/N 的「共同完成」，高估执行率。原并集口径保留为 coverageRate。
  const visitedStopsByProfile = new Map();
  for (const item of eligibleTrustCheckins) {
    const itemProfileId = normalizeProfileId(item?.profileId);
    const stopKey = checkinStopKey(item);
    if (!itemProfileId || itemProfileId === 'anonymous' || !stopKey) continue;
    const visited = visitedStopsByProfile.get(itemProfileId) ?? new Set();
    visited.add(stopKey);
    visitedStopsByProfile.set(itemProfileId, visited);
  }
  const perProfileCompletion = [...visitedStopsByProfile.values()].map((visited) => (routeStopCount ? Math.min(1, visited.size / routeStopCount) : 0));
  const completionRate =
    routeStopCount && perProfileCompletion.length
      ? Math.min(100, Math.round((perProfileCompletion.reduce((sum, ratio) => sum + ratio, 0) / perProfileCompletion.length) * 100))
      : 0;
  const coverageRate = routeStopCount ? Math.min(100, Math.round((uniqueVisitedStops.size / routeStopCount) * 100)) : 0;
  const pitfallRate = eligibleTrustCheckins.length ? Math.round((pitfallCount / eligibleTrustCheckins.length) * 1000) / 10 : 0;
  const positiveRate = eligibleTrustCheckins.length ? Math.round((positiveCount / eligibleTrustCheckins.length) * 1000) / 10 : 0;
  // 跳过率通道：按 profile + 出行日（本函数已按路线过滤）分组成「行程」，行程内
  // 有 isEligibleTrustCheckin 的有效到达锚定才计入；统计该行程内最终状态为
  // skipped/replaced 的站点占比后取行程平均。跳过打卡本身不要求 GPS。
  const journeyStops = new Map();
  for (const item of profileAttestedCheckins) {
    const itemProfileId = normalizeProfileId(item?.profileId);
    const stopKey = checkinStopKey(item);
    if (!itemProfileId || itemProfileId === 'anonymous' || !stopKey) continue;
    const journeyDay = localDateForTimestamp(checkinEventTime(item)) || 'unknown-day';
    const journeyId = `${itemProfileId}::${journeyDay}`;
    const stopsInJourney = journeyStops.get(journeyId) ?? new Map();
    // 行按最新在前排序，同一站点保留最终状态（跳过后又实地到达按到达计）。
    if (!stopsInJourney.has(stopKey)) stopsInJourney.set(stopKey, item);
    journeyStops.set(journeyId, stopsInJourney);
  }
  const anchoredJourneySkipShares = [];
  for (const stopsInJourney of journeyStops.values()) {
    const journeyRows = [...stopsInJourney.values()];
    if (!journeyRows.some(isEligibleTrustCheckin)) continue;
    const skippedOrReplaced = journeyRows.filter((item) => item?.status === 'skipped' || item?.status === 'replaced').length;
    anchoredJourneySkipShares.push(journeyRows.length ? skippedOrReplaced / journeyRows.length : 0);
  }
  const skipRate = anchoredJourneySkipShares.length
    ? Math.round((anchoredJourneySkipShares.reduce((sum, share) => sum + share, 0) / anchoredJourneySkipShares.length) * 1000) / 10
    : 0;
  const completeFeedbackRate = eligibleTrustCheckins.length ? Math.round((completeFeedbackCount / eligibleTrustCheckins.length) * 1000) / 10 : 0;
  const editRate = matchedHistory.length > 1 ? Math.round((editCount / Math.max(1, matchedHistory.length - 1)) * 1000) / 10 : 0;
  const copyCount = routebookCopyCount(matchedExposures, routeId);
  const copyConversionRate = shareExposureCount ? Math.round((copyCount / shareExposureCount) * 1000) / 10 : 0;
  const editPenalty = editRate > 60 && validArrivalCount < 2 ? 2 : editRate > 30 && validArrivalCount < 1 ? 1 : 0;
  // rank20②：已审核纠错进入路线级扣分与 POI 级降权（营业时间/关闭类）。
  const approvedCorrections = matchedCorrections.filter((item) => String(item?.status ?? '') === 'approved');
  const approvedCorrectionCount = approvedCorrections.length;
  const approvedHourCorrections = approvedCorrections.filter(isHoursOrClosureCorrection);
  // rank20③：用打卡时间与站点计划时间/停留时长比对，得到粗粒度时间吻合率。
  const timeMatchRate = calculateTimeMatchRate(trustedRouteStops, eligibleTrustCheckins);
  const feedbackScore = calculateFeedbackTrustScore({
    completionRate,
    positiveRate,
    editRate,
    completeFeedbackRate,
    skipRate,
    pitfallRate,
    lowConfidenceArrivalCount,
    approvedCorrectionCount,
    sampleCount: verifiedArrivalCheckins.length
  });
  // Evidence score from verifiable stop signals (recomputed on read: reviewed
  // facts expire). The stored routebook.trustScore and any model self-score are ignored.
  const evidence = routebookEvidence(routebook);
  const evidenceScore = evidence.score ?? 0;
  const trustBlend = blendRouteTrustScore(evidenceScore, feedbackScore, verifiedProfileCount);
  const poiTrust = buildPoiTrustByStop(routebook, globalPoiCheckins, approvedHourCorrections);
  return {
    checkinCount: matchedCheckins.length,
    attestedCheckinCount: eligibleTrustCheckins.length,
    ordinaryAttestedFeedbackCount: Math.max(0, attestedCheckins.length - eligibleTrustCheckins.length),
    untrustedCheckinCount: matchedCheckins.length - profileAttestedCheckins.length,
    visitedStopCount: uniqueVisitedStops.size,
    feedbackStopCount,
    completionRate,
    coverageRate,
    editCount,
    editRate,
    pitfallCount,
    pitfallRate,
    positiveCount,
    positiveRate,
    skipCount,
    skipRate,
    replacedCount,
    completeFeedbackCount,
    completeFeedbackRate,
    correctionCount: matchedCorrections.length,
    approvedCorrectionCount,
    ...(timeMatchRate == null ? {} : { timeMatchRate }),
    reviewCount: matchedReviews.length,
    saveVersionCount: matchedHistory.length || 1,
    shareExposureCount,
    copyCount,
    copyConversionRate,
    validArrivalCount,
    sampleCount: verifiedProfileCount,
    verifiedArrivalSampleCount: verifiedArrivalCheckins.length,
    verifiedProfileCount,
    attestedProfileCount,
    lowConfidenceArrivalCount,
    latestFeedbackAt: latestVerifiedAt,
    feedbackScore,
    evidenceScore,
    evidenceBreakdown: evidence.breakdown,
    // Kept for older clients; now equals evidenceScore (no model self-assessment).
    aiPredictionScore: evidenceScore,
    blendedTrustScore: trustBlend.score,
    aiWeight: trustBlend.aiWeight,
    feedbackWeight: trustBlend.feedbackWeight,
    trustScoreSource: trustBlend.source,
    trustCoverage: trustBlend.coverage,
    displayTrustScore: trustBlend.displayScore,
    poiTrust,
    trustDelta: Math.max(-12, Math.min(12, Math.round((completionRate - pitfallRate) / 12) + Math.min(4, validArrivalCount) - editPenalty))
  };
}

export async function enrichRoutebook(routebook, feedbackContext = null) {
  if (!routebook) return null;
  const opsAuditContext = feedbackContext?.opsAuditContext ?? (await buildOpsAuditContext());
  routebook = applyImportSourceOpsToRoutebook(routebook, opsAuditContext);
  const [feedbackSummary, poiKnowledge] = await Promise.all([
    buildFeedbackSummary(routebook, feedbackContext),
    listPoiKnowledge({ city: routebook.city, limit: 500 })
  ]);
  const stops = enrichStopsWithEvidence(routebook, routebook.stops ?? [], poiKnowledge, feedbackSummary);
  const variants = (routebook.variants ?? []).map((variant) => ({
    ...variant,
    stops: enrichStopsWithEvidence(routebook, variant.stops ?? [], poiKnowledge, feedbackSummary)
  }));
  const dynamicTrustScore = feedbackSummary.blendedTrustScore ?? 0;
  const { stops: evidenceStops } = routebookEvidence({ ...routebook, stops });
  return {
    ...routebook,
    stops: evidenceStops,
    variants: variants.map((variant) => ({
      ...variant,
      stops: routebookEvidence({ city: routebook.city, stops: variant.stops }).stops,
      validations: systemValidations(variant.validations),
      metrics: systemMetrics(variant.metrics)
    })),
    // Older routebooks stored model-written checks, metrics and "logs"; only
    // server-computed rows and signed server process logs are returned.
    validations: systemValidations(routebook.validations),
    logs: displayableProcessLogs(routebook),
    logsProof: undefined,
    copyCount: feedbackSummary.copyCount,
    trustScore: dynamicTrustScore,
    trustMeta: {
      predictionScore: feedbackSummary.evidenceScore,
      evidenceScore: feedbackSummary.evidenceScore,
      evidenceBreakdown: feedbackSummary.evidenceBreakdown,
      explanation: TRUST_SCORE_EXPLANATION,
      feedbackScore: feedbackSummary.feedbackScore,
      score: dynamicTrustScore,
      displayScore: feedbackSummary.displayTrustScore,
      source: feedbackSummary.trustScoreSource,
      label: trustProgressLabel(feedbackSummary),
      sampleTarget: PUBLIC_TRUST_SAMPLE_THRESHOLD,
      sampleCount: feedbackSummary.verifiedProfileCount,
      aiWeight: feedbackSummary.aiWeight,
      feedbackWeight: feedbackSummary.feedbackWeight,
      coverage: feedbackSummary.trustCoverage,
      latestVerifiedAt: feedbackSummary.latestFeedbackAt
    },
    feedbackSummary,
    metrics: mergeFeedbackMetrics(systemMetrics(routebook.metrics), feedbackSummary)
  };
}

function calculateFeedbackTrustScore(summary) {
  const completion = clampNumber(summary.completionRate, 0, 100, 0);
  const satisfaction = clampNumber(summary.positiveRate, 0, 100, 50);
  const lowEdit = 100 - clampNumber(summary.editRate, 0, 100, 0);
  const completeFeedback = clampNumber(summary.completeFeedbackRate, 0, 100, 0);
  const lowSkip = 100 - clampNumber(summary.skipRate, 0, 100, 0);
  const lowPitfall = 100 - clampNumber(summary.pitfallRate, 0, 100, 0);
  const confidenceBonus = Math.min(8, Math.floor(clampNumber(summary.sampleCount, 0, 1000, 0) / 3) * 2);
  const lowConfidencePenalty = Math.min(10, clampNumber(summary.lowConfidenceArrivalCount, 0, 100, 0) * 2);
  // rank20②：路线被审核通过的纠错越多，说明既有事实越不可靠，小幅扣分（上限 6）。
  const correctionPenalty = Math.min(6, clampNumber(summary.approvedCorrectionCount, 0, 1000, 0) * 2);
  return Math.round(
    clampNumber(
      completion * 0.32 +
        satisfaction * 0.22 +
        lowEdit * 0.14 +
        completeFeedback * 0.14 +
        lowSkip * 0.08 +
        lowPitfall * 0.1 +
        confidenceBonus -
        lowConfidencePenalty -
        correctionPenalty,
      35,
      98,
      60
    )
  );
}

const TIME_OF_DAY_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  timeZone: TRAVEL_DAY_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
});

function minutesOfDayInTravelTimezone(value) {
  const timestamp = Date.parse(value ?? '');
  if (!Number.isFinite(timestamp)) return null;
  const match = TIME_OF_DAY_FORMATTER.format(new Date(timestamp)).match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function parseStayMinutes(value) {
  const text = String(value ?? '');
  const hourMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:小时|h)/i);
  const minuteMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:分钟|分|min)/i);
  if (!hourMatch && !minuteMatch) return null;
  return Math.round((hourMatch ? Number(hourMatch[1]) * 60 : 0) + (minuteMatch ? Number(minuteMatch[1]) : 0));
}

function stopPlannedTimeWindow(stop) {
  const timeMatch = String(stop?.time ?? '').match(/(\d{1,2}):(\d{2})/);
  if (!timeMatch) return null;
  const start = Number(timeMatch[1]) * 60 + Number(timeMatch[2]);
  if (!Number.isFinite(start) || start >= 24 * 60) return null;
  const stay = parseStayMinutes(stop?.stay) ?? 60;
  return { start, end: start + Math.max(0, Math.min(12 * 60, stay)) };
}

// rank20③：粗粒度时间吻合率——打卡时刻（Asia/Shanghai）落在
// [计划到达-60min, 计划离开+60min] 记为吻合；无可比样本时返回 null。
function calculateTimeMatchRate(routeStops, checkins) {
  const samples = [];
  for (const item of checkins ?? []) {
    const checkinMinutes = minutesOfDayInTravelTimezone(checkinEventTime(item));
    if (checkinMinutes == null) continue;
    const stop = (routeStops ?? []).find((routeStop) => isSameCheckinStop(routeStop, item));
    const window = stopPlannedTimeWindow(stop);
    if (!window) continue;
    samples.push(checkinMinutes >= window.start - 60 && checkinMinutes <= window.end + 60);
  }
  if (!samples.length) return null;
  return Math.round((samples.filter(Boolean).length / samples.length) * 100);
}

function parseQueueMinutes(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (/无需|不用|免排|没排|无排队|不排队/.test(text)) return 0;
  return parseStayMinutes(text);
}

function parseCostYuan(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (/免费|免票/.test(text)) return 0;
  const match = text.match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function medianOf(values) {
  const sorted = (values ?? []).filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return Math.round(median * 10) / 10;
}

function modeOf(values) {
  const counts = new Map();
  for (const value of values ?? []) {
    const text = String(value ?? '').trim();
    if (!text) continue;
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  let winner = '';
  let winnerCount = 0;
  for (const [value, count] of counts) {
    if (count > winnerCount) {
      winner = value;
      winnerCount = count;
    }
  }
  return winner;
}

// "待真实验证" reads as broken to users and hides progress from ops; show how far the
// route is from the sample threshold instead.
function trustProgressLabel(feedbackSummary) {
  if (feedbackSummary.trustScoreSource === 'verified-feedback') {
    const attested = clampNumber(feedbackSummary.attestedProfileCount, 0, 1000000, 0);
    return attested ? '真实打卡验证可信分' : '独立身份打卡验证可信分';
  }
  const samples = clampNumber(feedbackSummary.verifiedProfileCount, 0, 1000000, 0);
  return samples
    ? `资料核对 · 已有 ${samples}/${PUBLIC_TRUST_SAMPLE_THRESHOLD} 人打卡（满 ${PUBLIC_TRUST_SAMPLE_THRESHOLD} 人才评分）`
    : `还没人打卡（满 ${PUBLIC_TRUST_SAMPLE_THRESHOLD} 人才评分）`;
}

function blendRouteTrustScore(evidenceScore, feedbackScore, sampleCount) {
  const samples = clampNumber(sampleCount, 0, 100000, 0);
  const coverage = Math.min(1, samples / Math.max(1, TRUST_FEEDBACK_SAMPLE_TARGET));
  const feedbackWeight = Math.round(coverage * 0.75 * 100) / 100;
  const aiWeight = Math.round((1 - feedbackWeight) * 100) / 100;
  const score = Math.round(clampNumber(evidenceScore * aiWeight + feedbackScore * feedbackWeight, 0, 100, evidenceScore));
  return {
    score,
    displayScore: samples >= PUBLIC_TRUST_SAMPLE_THRESHOLD ? score : null,
    aiWeight,
    feedbackWeight,
    coverage: Math.round(coverage * 100),
    source: samples >= PUBLIC_TRUST_SAMPLE_THRESHOLD ? 'verified-feedback' : 'prediction'
  };
}

function buildPoiTrustByStop(routebook, attestedCheckins = [], approvedHourCorrections = []) {
  // 键改用 resolvePoiId：stop.id（如 stop-1）会在主线与变体之间撞库，把别的
  // POI 的可信分挂错；同时覆盖变体站点，让变体也能继承跨路线 POI 反馈。
  const stops = [...(routebook?.stops ?? []), ...(routebook?.variants ?? []).flatMap((variant) => variant?.stops ?? [])];
  const sinceMs = Date.now() - POI_FEEDBACK_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const recentRows = attestedCheckins.filter((item) => {
    const time = Date.parse(item.createdAt ?? item.time ?? '');
    return Number.isFinite(time) && time >= sinceMs;
  });
  const recentHourCorrections = (approvedHourCorrections ?? []).filter((item) => {
    const time = Date.parse(item?.reviewedAt ?? item?.createdAt ?? '');
    return Number.isFinite(time) && time >= sinceMs;
  });
  const map = new Map();
  for (const stop of stops) {
    const stopPoiId = resolvePoiId(stop, routebook?.city);
    if (!stopPoiId || map.has(stopPoiId)) continue;
    const rows = recentRows.filter((item) => poiCheckinKey(item) === stopPoiId && isEligibleTrustCheckin(item));
    const independentProfileCount = new Set(rows.map((item) => normalizeProfileId(item.profileId)).filter((id) => id && id !== 'anonymous')).size;
    const validRows = rows;
    const positiveRows = validRows.filter((item) => item.worth === '值得');
    const pitfallRows = validRows.filter((item) => item.worth === '踩坑' || item.pitfall);
    const skippedRows = validRows.filter((item) => item.worth === '跳过');
    const latestVerifiedAt =
      validRows
        .map((item) => item.createdAt ?? item.time)
        .filter(Boolean)
        .sort()
        .at(-1) ?? null;
    const freshnessDays = latestVerifiedAt ? Math.max(0, Math.floor((Date.now() - Date.parse(latestVerifiedAt)) / (24 * 60 * 60 * 1000))) : null;
    const positiveRate = validRows.length ? Math.round((positiveRows.length / validRows.length) * 1000) / 10 : 0;
    const pitfallRate = validRows.length ? Math.round((pitfallRows.length / validRows.length) * 1000) / 10 : 0;
    const skipRate = validRows.length ? Math.round((skippedRows.length / validRows.length) * 1000) / 10 : 0;
    const freshnessScore = latestVerifiedAt ? Math.max(0, 100 - Math.floor((Date.now() - Date.parse(latestVerifiedAt)) / (24 * 60 * 60 * 1000)) * 3) : 0;
    // rank20②：近 30 天营业时间/关闭类已审核纠错对该 POI 施加降权（每条 -4，上限 -12）。
    const recentCorrectionCount = recentHourCorrections.filter((item) => isSamePoi({ ...stop, city: routebook?.city }, item)).length;
    const correctionPenalty = Math.min(12, recentCorrectionCount * 4);
    const score = independentProfileCount
      ? Math.round(
          clampNumber(
            42 +
              Math.min(24, independentProfileCount * 4) +
              positiveRate * 0.14 +
              freshnessScore * 0.12 -
              pitfallRate * 0.22 -
              skipRate * 0.12 -
              correctionPenalty,
            30,
            96,
            50
          )
        )
      : null;
    // rank20①：近 30 天有效样本的经验聚合（人群/排队/花费/拥挤/最新反馈时间）。
    const audienceCounts = new Map();
    for (const item of validRows) {
      const label = truncateString(item?.audience, 80);
      if (label) audienceCounts.set(label, (audienceCounts.get(label) ?? 0) + 1);
    }
    const audienceTotal = [...audienceCounts.values()].reduce((sum, count) => sum + count, 0);
    const audienceBreakdown =
      audienceTotal >= 2
        ? [...audienceCounts.entries()]
            .map(([label, count]) => ({ label, count, share: Math.round((count / audienceTotal) * 100) }))
            .sort((left, right) => right.count - left.count)
            .slice(0, 6)
        : [];
    const queueMinutesMedian = medianOf(validRows.map((item) => parseQueueMinutes(item?.queue)));
    const costMedian = medianOf(validRows.map((item) => parseCostYuan(item?.cost)));
    const crowdLevel = modeOf(validRows.map((item) => item?.crowd));
    map.set(stopPoiId, {
      score,
      scope: 'cross-route-poi',
      sampleCount: independentProfileCount,
      recentCheckins: validRows.length,
      validArrivals: validRows.length,
      positiveRate,
      pitfallRate,
      skipRate,
      audienceBreakdown,
      queueMinutesMedian,
      costMedian,
      crowdLevel,
      latestVerifiedAt,
      latestFeedbackAt: latestVerifiedAt,
      freshnessDays,
      recentCorrectionCount,
      trustState: independentProfileCount >= PUBLIC_TRUST_SAMPLE_THRESHOLD ? 'verified' : independentProfileCount > 0 ? 'collecting' : 'pending',
      freshnessLabel: latestVerifiedAt ? `${daysAgoLabel(latestVerifiedAt)}有人验证` : '待真实验证',
      label: independentProfileCount ? `近 ${POI_FEEDBACK_WINDOW_DAYS} 天 ${independentProfileCount} 位独立身份跨路线有效到达` : '待真实打卡'
    });
  }
  return Object.fromEntries(map);
}

function stopTrustKey(stop) {
  return String(stop?.id || stop?.name || '').trim();
}

function isSameCheckinStop(stop, checkin) {
  const stopPoiId = sanitizePublicId(stop?.poiId);
  const checkinPoiId = sanitizePublicId(checkin?.poiId);
  const stopId = String(stop?.id ?? '');
  const localStopKey = String(checkin?.localStopKey ?? '');
  const checkinStopId = String(checkin?.stopId ?? '');
  const stopName = String(stop?.name ?? '');
  const checkinStopName = String(checkin?.stopName ?? '');
  return Boolean(
    (stopPoiId && checkinPoiId && stopPoiId === checkinPoiId) ||
    (stopId && localStopKey && stopId === localStopKey) ||
    (stopId && checkinStopId && stopId === checkinStopId) ||
    (stopName && checkinStopName && normalizePoiName(stopName) === normalizePoiName(checkinStopName)) ||
    resolvePoiId(stop, checkin?.city) === resolvePoiId(checkin, checkin?.city)
  );
}

function daysAgoLabel(isoValue) {
  const timestamp = Date.parse(isoValue ?? '');
  if (!Number.isFinite(timestamp)) return '近期';
  const days = Math.max(0, Math.floor((Date.now() - timestamp) / (24 * 60 * 60 * 1000)));
  if (days === 0) return '今天';
  if (days === 1) return '昨天';
  return `${days} 天前`;
}

function enrichStopsWithEvidence(routebook, stops, poiKnowledge, feedbackSummary = null) {
  return stops.map((stop) => {
    const corrections = poiKnowledge.filter((item) => isSamePoi(stop, item)).slice(0, 5);
    // 新口径按 resolvePoiId 取 POI 可信分；stopTrustKey 仅作为读取历史
    // 已落盘 feedbackSummary（旧键）的兼容回退。
    const poiKey = resolvePoiId(stop, routebook?.city);
    const legacyKey = stopTrustKey(stop);
    const poiTrust =
      feedbackSummary?.poiTrust?.[poiKey] ??
      feedbackSummary?.poiTrust?.[legacyKey] ??
      routebook?.feedbackSummary?.poiTrust?.[poiKey] ??
      routebook?.feedbackSummary?.poiTrust?.[legacyKey] ??
      routebook?.poiTrust?.[poiKey] ??
      routebook?.poiTrust?.[legacyKey] ??
      null;
    const evidence = normalizeStopEvidence([
      ...(stop.sourceEvidence ?? []),
      ...buildSourceEvidenceForStop(routebook, stop),
      ...corrections.map((item) => ({
        id: item.correctionId || item.id,
        type: 'approved-correction',
        label: `已审核纠错｜${item.field}`,
        detail: [item.value, item.reason ? `依据：${item.reason}` : '', item.reviewerNote ? `审核：${item.reviewerNote}` : ''].filter(Boolean).join('；'),
        trustScore: null,
        checkedAt: item.createdAt
      }))
    ]);
    return {
      ...stop,
      poiTrust,
      approvedCorrections: corrections,
      sourceEvidence: evidence,
      facts: buildStopFacts(routebook, stop, corrections, evidence)
    };
  });
}

function buildStopFacts(routebook, stop, corrections, evidence) {
  const sourceFacts = buildFactsFromSources(routebook, stop, evidence);
  const correctionFacts = corrections.map((item) => ({
    id: `correction-${item.correctionId || item.id}`,
    field: item.field || '综合信息',
    value: item.value,
    confidence: 88,
    sourceLabel: '运营已审纠错',
    sourceType: 'approved-correction',
    sourceUrl: '',
    status: '已审核',
    checkedAt: item.createdAt
  }));
  const fallbackFacts = [
    { id: 'fact-stay', field: '建议停留', value: stop.stay, confidence: 66, sourceLabel: 'AI 路线校验', sourceType: 'routebook', status: '需实地校准' },
    {
      id: 'fact-cost',
      field: '费用',
      value: stop.cost,
      confidence: /\d/.test(String(stop.cost ?? '')) ? 64 : 45,
      sourceLabel: 'AI 预算估算',
      sourceType: 'routebook',
      status: '需出发前复核'
    },
    { id: 'fact-risk', field: '风险', value: stop.risk, confidence: 68, sourceLabel: 'AI 风险摘要', sourceType: 'routebook', status: '需复核' }
  ];
  // Source-derived snapshots are recomputed against today's authorization overlay.
  const existingFacts = normalizeStopFacts(stop.facts).filter(
    (fact) => !String(fact.id).startsWith('source-fact-') && !['matched-source', 'route-source'].includes(fact.sourceType)
  );
  const merged = [...existingFacts, ...correctionFacts, ...sourceFacts, ...fallbackFacts];
  const latestByField = new Map();
  for (const fact of normalizeStopFacts(merged)) {
    const key = `${fact.field}:${fact.value}`;
    if (!latestByField.has(key)) latestByField.set(key, fact);
  }
  return [...latestByField.values()].slice(0, 8);
}

function buildFactsFromSources(routebook, stop, evidence = []) {
  const stopName = String(stop?.name ?? '');
  const relevant = evidence.filter((item) => item.type === 'matched-source' || String(item.detail ?? '').includes(stopName));
  return relevant.slice(0, 3).flatMap((item) => {
    const facts = [];
    const text = `${item.label ?? ''} ${item.detail ?? ''}`;
    if (/开放|营业|闭店|暂停|预约|限流/.test(text)) {
      facts.push({ field: '开放时间', value: item.detail, status: '来源提示' });
    }
    if (/票|门票|元|人均|价格|涨价/.test(text)) {
      facts.push({ field: '费用', value: item.detail, status: '来源提示' });
    }
    if (/排队|拥挤|人多|避开|高峰/.test(text)) {
      facts.push({ field: '拥挤风险', value: item.detail, status: '来源提示' });
    }
    if (!facts.length && item.detail) {
      facts.push({ field: '来源摘要', value: item.detail, status: '来源提示' });
    }
    return facts.map((fact, index) => ({
      id: `source-fact-${sanitizePublicId(item.id)}-${index + 1}`,
      ...fact,
      confidence: item.trustScore == null ? 58 : clampNumber(item.trustScore, 0, 100, 58),
      sourceLabel: item.label,
      sourceType: item.type,
      sourceUrl: item.url,
      checkedAt: item.checkedAt
    }));
  });
}

// 判同收紧为 resolvePoiId 相等或规范化名称完全相等；子串包含（如「柳浪闻莺」
// 与「柳浪闻莺东门」）只能作为低置信提示，不再直接判定为同一 POI。
function isSamePoi(stop, item) {
  const stopName = String(stop?.name ?? '');
  const itemName = String(item?.stopName ?? '');
  if (!stopName || !itemName) return false;
  const city = stop?.city || item?.city || '';
  if (resolvePoiId({ name: stopName }, city) === resolvePoiId({ name: itemName }, item?.city || city)) return true;
  const normalizedStopName = normalizePoiName(stopName);
  const normalizedItemName = normalizePoiName(itemName);
  return Boolean(normalizedStopName) && normalizedStopName === normalizedItemName;
}

function buildSourceEvidenceForStop(routebook, stop) {
  const authorizedIds = new Set((routebook?.importedSources ?? []).filter((source) => source.authorizationStatus === 'authorized-public').map(importSourceId));
  const sources = normalizeImportedSources(routebook?.importedSources).filter((source) => authorizedIds.has(importSourceId(source)));
  if (!sources.length) return [];
  const stopName = String(stop?.name ?? '');
  const area = String(stop?.area ?? '');
  const matched = sources.filter((source) => {
    const haystack = `${source.title} ${source.description} ${source.excerpt}`;
    return (stopName && haystack.includes(stopName)) || (area && haystack.includes(area));
  });
  const selected = matched.length ? matched : sources.slice(0, 1);
  return selected.slice(0, 3).map((source) => ({
    id: importSourceId(source),
    sourceId: importSourceId(source),
    authorizationStatus: 'authorized-public',
    type: matched.length ? 'matched-source' : 'route-source',
    label: `${source.platform || '导入来源'}｜可信 ${source.trustScore}`,
    detail: matched.length
      ? truncateString(source.title || source.description || source.excerpt || '来源命中该站点，需要出发前复核。', 220)
      : truncateString(`路线级来源，未在公开摘要中逐点命中「${stopName}」。${source.title || source.description || ''}`, 220),
    platform: source.platform,
    trustScore: source.trustScore,
    url: source.url,
    checkedAt: source.fetchedAt
  }));
}

function mergeFeedbackMetrics(metrics, feedbackSummary) {
  const trustedFeedbackCount = feedbackSummary.attestedCheckinCount ?? 0;
  const feedbackMetrics = [
    { label: '认证打卡', value: trustedFeedbackCount ? `${trustedFeedbackCount} 次` : '待验证' },
    { label: '有效到达', value: trustedFeedbackCount ? `${feedbackSummary.completionRate}%` : '待验证' },
    { label: '踩坑率', value: trustedFeedbackCount ? `${feedbackSummary.pitfallRate}%` : '待验证' },
    { label: '平均修改', value: feedbackSummary.saveVersionCount > 1 ? `${feedbackSummary.editRate}%` : '待验证' },
    { label: '最近验证', value: feedbackSummary.latestFeedbackAt ? new Date(feedbackSummary.latestFeedbackAt).toLocaleDateString('zh-CN') : '待验证' },
    { label: '复制转化', value: feedbackSummary.shareExposureCount ? `${feedbackSummary.copyConversionRate}%` : `${feedbackSummary.copyCount} 次` },
    { label: '纠错反馈', value: `${feedbackSummary.correctionCount} 条` }
  ];
  const replacedLabels = new Set(['真实打卡', ...feedbackMetrics.map((item) => item.label)]);
  return [...feedbackMetrics, ...metrics.filter((item) => !replacedLabels.has(item.label))].slice(0, 8);
}

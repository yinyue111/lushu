// Ops dashboard, product analytics and creator profiles.
import { countBy, sanitizePublicId, intersectSets, percent } from '../lib/util.mjs';
import { buildActivationFunnel, buildTrustBehavior, medianMinutesToFirstSuccess } from './funnelEvents.mjs';
import { CLIENT_ERROR_LOG_PATH, FUNNEL_LOG_PATH } from '../config/index.mjs';
import {
  CLICK_LOG_PATH,
  EXPOSURE_LOG_PATH,
  AI_LOG_PATH,
  CHECKIN_LOG_PATH,
  FAVORITE_LOG_PATH,
  IMPORT_LOG_PATH,
  REVIEW_LOG_PATH,
  TRAVEL_DAY_TIME_ZONE,
  TRAVEL_DAY_WINDOW_DAYS,
  PUBLIC_ROUTE_STATUSES
} from '../config/index.mjs';
import { readJsonLines, readMatchingJsonLines } from '../storage/jsonl.mjs';
import { normalizeProfileId } from '../auth/tokens.mjs';
import { normalizeTravelDate, normalizeCreator } from '../routebooks/normalize.mjs';
import { isEligibleTrustCheckin, isTravelDateCheckin, isTravelDateEvent } from '../trust/checkins.mjs';
import { totalRoutebookCopyCount, routebookCopyCount } from '../routebooks/copies.mjs';
import { listSavedRoutebooks } from '../routebooks/list.mjs';
import { buildRouteFeedbackContext, enrichRoutebook } from '../trust/feedback.mjs';
import { publicRoutebookView } from '../routebooks/views.mjs';
import { calculateOperationalMetrics } from './operationalMetrics.mjs';
import { applyCheckinOpsOverlay, buildOpsAuditContext } from '../ops/audit.mjs';
import { buildProductFunnelAnalytics } from './productFunnel.mjs';
import { buildConstraintSatisfaction } from './constraintMetrics.mjs';

async function buildOperationalMetrics(asOf) {
  const since = asOf - 37 * 86400000;
  const inWindow = (row) => {
    const timestamp = Date.parse(row?.createdAt ?? '');
    return Number.isFinite(timestamp) && timestamp >= since && timestamp <= asOf;
  };
  const [aiLogs, exposures, ...activityGroups] = await Promise.all([
    readJsonLines(AI_LOG_PATH, Number.POSITIVE_INFINITY),
    ...[EXPOSURE_LOG_PATH, CHECKIN_LOG_PATH, FAVORITE_LOG_PATH, REVIEW_LOG_PATH, IMPORT_LOG_PATH, CLICK_LOG_PATH].map((path) =>
      readMatchingJsonLines(path, inWindow, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)
    )
  ]);
  const metrics = calculateOperationalMetrics({ aiLogs, exposures, activityRows: activityGroups.flat(), asOf });
  // No end-user feedback control currently produces these events. A zero must
  // not masquerade as "no complaints" when collection has not been implemented.
  for (const metric of ['aiSatisfactionRate', 'unusableComplaintRate']) {
    metrics.funnel[metric] = null;
    metrics.funnel[`${metric}Status`] = 'not-instrumented';
  }
  metrics.metricDefinitions.aiSatisfaction.status = 'not-instrumented';
  metrics.metricDefinitions.unusableComplaint.status = 'not-instrumented';
  return metrics;
}

export async function buildProductAnalytics(limit = 500, profileId = '') {
  // Both sides must use the same complete population; independent tail windows skew CTR.
  void limit;
  const [clicks, exposures] = await Promise.all([
    readJsonLines(CLICK_LOG_PATH, Number.POSITIVE_INFINITY),
    readJsonLines(EXPOSURE_LOG_PATH, Number.POSITIVE_INFINITY)
  ]);
  return buildProductFunnelAnalytics({ clicks, exposures, profileId });
}

function journeyKey(row = {}) {
  const profileId = normalizeProfileId(row?.profileId);
  const routeId = sanitizePublicId(row?.routeId || row?.publicId || row?.itemId);
  if (!routeId || !profileId || profileId === 'anonymous') return '';
  return `${profileId}::${routeId}`;
}

function journeyRouteId(key) {
  return String(key ?? '').split('::')[1] || '';
}

function journeyDateKey(row = {}) {
  const baseKey = journeyKey(row);
  const travelDate = normalizeTravelDate(row?.travelDate);
  return baseKey && travelDate ? `${baseKey}::${travelDate}` : '';
}

function journeyBaseKeyFromDateKey(key) {
  return String(key ?? '')
    .split('::')
    .slice(0, 2)
    .join('::');
}

function journeyTravelDateFromKey(key) {
  return normalizeTravelDate(String(key ?? '').split('::')[2]);
}

function distinctJourneyKeys(rows) {
  return new Set((rows ?? []).map(journeyKey).filter(Boolean));
}

function distinctJourneyDateKeys(rows) {
  return new Set((rows ?? []).map(journeyDateKey).filter(Boolean));
}

function indexJourneyDatesByBase(dateKeys) {
  const datesByBase = new Map();
  for (const dateKey of dateKeys ?? []) {
    const baseKey = journeyBaseKeyFromDateKey(dateKey);
    if (!baseKey) continue;
    const keys = datesByBase.get(baseKey) ?? [];
    keys.push(dateKey);
    datesByBase.set(baseKey, keys);
  }
  return datesByBase;
}

// 已删除/需登录（unavailable）的来源同样算解析失败，不能从分母里消失而抬高解析率。
const RECORDED_IMPORT_STATUSES = new Set(['fetched', 'metadata-only', 'unavailable', 'failed']);

export function summarizeImportAnalysis(imports) {
  const recordedImportSources = (Array.isArray(imports) ? imports : [])
    .flatMap((item) => (Array.isArray(item?.sources) ? item.sources : []))
    .filter((source) => RECORDED_IMPORT_STATUSES.has(source?.status));
  const importAnalysisSucceeded = recordedImportSources.filter((source) => source.status === 'fetched').length;
  return { recordedImportSources, importAnalysisSucceeded, importAnalysisFailed: recordedImportSources.length - importAnalysisSucceeded };
}

export async function buildPlatformDashboard(limit = 1000) {
  const asOf = Date.now();
  const [aiLogs, routebooks, rawCheckins, favorites, reviews, imports, clicks, exposures, opsAuditContext, operationalMetrics, funnelRows, clientErrors] = await Promise.all([
    readJsonLines(AI_LOG_PATH, limit),
    listSavedRoutebooks(Math.min(limit, 500)),
    readJsonLines(CHECKIN_LOG_PATH, limit),
    readJsonLines(FAVORITE_LOG_PATH, limit),
    readJsonLines(REVIEW_LOG_PATH, limit),
    readJsonLines(IMPORT_LOG_PATH, limit),
    readJsonLines(CLICK_LOG_PATH, limit),
    readJsonLines(EXPOSURE_LOG_PATH, limit),
    buildOpsAuditContext(),
    buildOperationalMetrics(asOf),
    readJsonLines(FUNNEL_LOG_PATH, Math.max(limit, 5000)),
    readJsonLines(CLIENT_ERROR_LOG_PATH, 500)
  ]);
  const checkins = rawCheckins.map((item) => applyCheckinOpsOverlay(item, opsAuditContext));
  const generatedOk = aiLogs.filter((item) => item.kind === 'generate-routebook' && item.status === 'ok').length;
  const generateAttempts = aiLogs.filter((item) => item.kind === 'generate-routebook').length;
  const generatedRouteIds = new Set(
    aiLogs
      .filter((item) => item.kind === 'generate-routebook' && item.status === 'ok')
      .map((item) => sanitizePublicId(item.publicId))
      .filter(Boolean)
  );
  const routebooksById = new Map(routebooks.map((item) => [sanitizePublicId(item.publicId || item.id), item]));
  const journeyEvents = exposures.filter((item) => item.itemType === 'journey-event');
  const saveJourneyEvents = journeyEvents.filter((item) => item.surface === 'routebook-save');
  const savedJourneyKeys = distinctJourneyKeys(saveJourneyEvents);
  const savedDatedJourneyKeys = distinctJourneyDateKeys(saveJourneyEvents);
  const savedJourneyDatesByBase = indexJourneyDatesByBase(savedDatedJourneyKeys);
  const tripOpenEvents = journeyEvents.filter((item) => item.surface === 'trip-open');
  const tripOpenJourneyKeys = distinctJourneyKeys(tripOpenEvents);
  const validCheckinDatedJourneyKeys = new Set();
  const eligibleExecutionCheckins = checkins.filter((item) => {
    if (!isEligibleTrustCheckin(item)) return false;
    const datedKeys = savedJourneyDatesByBase.get(journeyKey(item)) ?? [];
    let matched = false;
    for (const datedKey of datedKeys) {
      // 打卡行按 checkinEventTime（observedAt 优先）对齐出行日；exposures 不变。
      if (!isTravelDateCheckin(journeyTravelDateFromKey(datedKey), item)) continue;
      validCheckinDatedJourneyKeys.add(datedKey);
      matched = true;
    }
    return matched;
  });
  const validCheckinKeys = distinctJourneyKeys(eligibleExecutionCheckins);
  const travelDayOpenedJourneyKeys = distinctJourneyDateKeys(
    tripOpenEvents.filter((event) => {
      const dateKey = journeyDateKey(event);
      return Boolean(dateKey && savedDatedJourneyKeys.has(dateKey) && isTravelDateEvent(journeyTravelDateFromKey(dateKey), event));
    })
  );
  const effectiveExecutedJourneyKeys = intersectSets(travelDayOpenedJourneyKeys, validCheckinDatedJourneyKeys);
  const openedJourneyKeys = new Set([...tripOpenJourneyKeys, ...validCheckinKeys]);
  const savedOpenedJourneyKeys = intersectSets(openedJourneyKeys, savedJourneyKeys);
  const sharedJourneyKeys = distinctJourneyKeys(journeyEvents.filter((item) => item.surface === 'routebook-share'));
  const savedSharedJourneyKeys = intersectSets(sharedJourneyKeys, savedJourneyKeys);
  const savedGeneratedRouteIds = new Set([...savedJourneyKeys].map(journeyRouteId).filter((routeId) => generatedRouteIds.has(routeId)));
  const editedJourneyKeys = new Set(
    [...savedJourneyKeys].filter((key) => {
      const routebook = routebooksById.get(journeyRouteId(key));
      return Boolean(routebook?.provider?.editedAt || routebook?.provider?.statusUpdatedAt || routebook?.activeVariantId);
    })
  );
  const { recordedImportSources, importAnalysisSucceeded, importAnalysisFailed } = summarizeImportAnalysis(imports);
  const savedRoutebooks = savedJourneyKeys.size;
  const validCheckins = eligibleExecutionCheckins.length;
  const sharedRoutebooks = savedSharedJourneyKeys.size;
  const editedRoutebooks = editedJourneyKeys.size;
  const legacyJourneyEventsMissingTravelDate = journeyEvents.filter((item) => !normalizeTravelDate(item?.travelDate)).length;
  const copiedCount = totalRoutebookCopyCount(exposures);
  const productAnalytics = await buildProductAnalytics(limit);
  const constraintSatisfaction = buildConstraintSatisfaction(routebooks, { routeIds: generatedRouteIds });
  // 内测激活漏斗（近 30 天）与前端错误（近 24 小时）。
  const activation = buildActivationFunnel(funnelRows, aiLogs, { sinceMs: asOf - 30 * 86_400_000 });
  const recentClientErrors = clientErrors.filter((row) => Date.parse(row.createdAt) >= asOf - 86_400_000);
  const funnel = {
    activation,
    activationCohortSize: activation.cohortSize,
    // 分享页：被打开次数 → 在分享页上「用 / 存 / 改成适合我的」次数（近 30 天）。
    shareOpens30d: funnelRows.filter((row) => row?.event === 'share_open' && Date.parse(row.createdAt) >= asOf - 30 * 86_400_000).length,
    shareCopies30d: funnelRows.filter((row) => row?.event === 'share_copy' && Date.parse(row.createdAt) >= asOf - 30 * 86_400_000).length,
    activationAnonymousEvents: activation.anonymousEvents,
    timeToFirstSuccess: medianMinutesToFirstSuccess(funnelRows, aiLogs, { sinceMs: asOf - 30 * 86_400_000 }),
    trustBehavior: buildTrustBehavior(funnelRows, { sinceMs: asOf - 30 * 86_400_000 }),
    clientErrors24h: recentClientErrors.length,
    latestClientErrors: recentClientErrors.slice(-5).reverse().map(({ kind, message, path, createdAt }) => ({ kind, message, path, createdAt })),
    generateAttempts,
    generatedOk,
    generatedRoutes: generatedRouteIds.size,
    generationSuccessRate: percent(generatedOk, generateAttempts),
    storedRoutebooks: routebooks.length,
    savedRoutebooks,
    // saveRate 的分子口径单独透出，便于运营台核对「AI 生成且被保存」的数量。
    savedGeneratedRoutebooks: savedGeneratedRouteIds.size,
    saveRate: percent(savedGeneratedRouteIds.size, generatedRouteIds.size),
    editedRoutebooks,
    editRate: percent(editedRoutebooks, savedRoutebooks),
    explicitTripOpenedJourneys: tripOpenJourneyKeys.size,
    tripOpenedJourneys: openedJourneyKeys.size,
    savedAnyTripOpenedJourneys: savedOpenedJourneyKeys.size,
    travelDateSavedRoutebooks: savedDatedJourneyKeys.size,
    savedTripOpenedJourneys: travelDayOpenedJourneyKeys.size,
    tripDayOpenRate: percent(travelDayOpenedJourneyKeys.size, savedDatedJourneyKeys.size),
    effectiveExecutedRoutebooks: effectiveExecutedJourneyKeys.size,
    effectiveExecutionRate: percent(effectiveExecutedJourneyKeys.size, savedDatedJourneyKeys.size),
    validCheckins,
    validCheckinJourneys: validCheckinKeys.size,
    checkinRate: percent(validCheckinKeys.size, openedJourneyKeys.size),
    travelDayCheckinRate: percent(effectiveExecutedJourneyKeys.size, travelDayOpenedJourneyKeys.size),
    sharedRoutebooks,
    shareRate: percent(sharedRoutebooks, savedRoutebooks),
    copiedCount,
    favoriteCount: favorites.length,
    reviewCount: reviews.length,
    importCount: imports.length,
    importAnalysisAttempts: recordedImportSources.length,
    importAnalysisSucceeded,
    importAnalysisFailed,
    importAnalysisSuccessRate: percent(importAnalysisSucceeded, recordedImportSources.length),
    legacyJourneyEventsMissingTravelDate,
    exposureCount: exposures.length,
    clickCount: clicks.length,
    clickThroughRate: productAnalytics.overallCtr,
    constraintSatisfactionRate: constraintSatisfaction.satisfactionRate,
    constraintSatisfaction,
    // 商品点击后的外跳（redirect）尚无事件采集；不展示 0%。
    redirectRate: null,
    redirectRateStatus: 'not-instrumented',
    ...operationalMetrics.funnel
  };
  return {
    funnel,
    metricDefinitions: {
      ...operationalMetrics.metricDefinitions,
      legacyCounters: { scope: 'recent-records', limit, note: '原有漏斗和商品 CTR 基于各事件流最近 N 条，非固定日期全量；新增运营指标单独标注滚动窗口和分母' },
      tripDayOpen: {
        numerator: '保存事件冻结的 profileId + routeId + travelDate，与同日期快照的 trip-open 关联，且打开时间在该日期前后 1 天',
        denominator: '保存事件中带有效 travelDate 快照的 profileId + routeId + travelDate 组合；缺失快照的历史事件不回填',
        timezone: TRAVEL_DAY_TIME_ZONE,
        windowDaysBefore: TRAVEL_DAY_WINDOW_DAYS,
        windowDaysAfter: TRAVEL_DAY_WINDOW_DAYS
      },
      effectiveExecution: {
        numerator:
          '已保存且同日期快照在出行日前后 1 天打开，并由同一绑定身份与路书在该日期前后 1 天产生 visited + 有效 GPS 到达的 profileId + routeId + travelDate 组合',
        denominator: '保存事件中带有效 travelDate 快照的 profileId + routeId + travelDate 组合；缺失快照的历史事件不回填',
        timezone: TRAVEL_DAY_TIME_ZONE,
        windowDaysBefore: TRAVEL_DAY_WINDOW_DAYS,
        windowDaysAfter: TRAVEL_DAY_WINDOW_DAYS
      },
      constraintSatisfaction: {
        numerator: 'AI 生成路书当前版本中，必去/避开核对为“已纳入”与预算核对为“可控”的项数',
        denominator: '上述两类核对中结论明确（满足或未满足/超预算）的项数；“需人工确认”“待复核”“未设置”单独计数，不进分母',
        scope: '最近保存的路书（与 legacyCounters 同一窗口），仅限 AI 生成成功记录中的路书'
      },
      redirect: { status: 'not-instrumented', note: '曝光→点击已采集；点击后的外跳/下单没有事件，需接入后再统计' },
      importAnalysis: {
        numerator: '状态为 fetched 的已记录来源',
        denominator: '明确记录为 fetched、metadata-only、unavailable（已删除/需登录）或 failed 的来源'
      }
    },
    byCity: aggregateRoutebooksByCity(routebooks, checkins),
    topCreators: aggregateCreators(routebooks, checkins, favorites, clicks, exposures),
    productAnalytics,
    recentActivity: buildRecentActivity({ aiLogs, routebooks, checkins, favorites, reviews, imports, clicks, exposures })
  };
}

function aggregateRoutebooksByCity(routebooks, checkins) {
  const checkinsByCity = countBy(checkins.filter(isEligibleTrustCheckin), (item) => item.city);
  const map = new Map();
  for (const routebook of routebooks) {
    const city = routebook.city || '未知城市';
    const item = map.get(city) ?? { city, routebookCount: 0, featuredCount: 0, predictionScoreTotal: 0, validCheckins: checkinsByCity.get(city) ?? 0 };
    item.routebookCount += 1;
    if (routebook.publishStatus === 'featured') item.featuredCount += 1;
    item.predictionScoreTotal += Number(routebook.trustScore ?? 0);
    map.set(city, item);
  }
  return [...map.values()]
    .map(({ predictionScoreTotal, ...item }) => ({
      ...item,
      avgPredictionScore: item.routebookCount ? Math.round(predictionScoreTotal / item.routebookCount) : null
    }))
    .sort((a, b) => b.routebookCount - a.routebookCount)
    .slice(0, 12);
}

function aggregateCreators(routebooks, checkins = [], favorites = [], clicks = [], exposures = []) {
  const validCheckinsByRoute = countBy(checkins.filter(isEligibleTrustCheckin), (item) => item.routeId || item.routeTitle);
  const favoritesByRoute = countBy(favorites, (item) => item.routeId || item.routeTitle);
  const clicksByCreator = countBy(clicks, (item) => item.creatorId);
  const map = new Map();
  for (const routebook of routebooks) {
    const creator = normalizeCreator(routebook.creator);
    const item = map.get(creator.id) ?? {
      creator,
      routebookCount: 0,
      copyCount: 0,
      validCheckins: 0,
      favoriteCount: 0,
      clickCount: clicksByCreator.get(creator.id) ?? 0,
      predictionScoreTotal: 0
    };
    item.routebookCount += 1;
    item.copyCount += routebookCopyCount(exposures, routebook.publicId || routebook.id);
    item.validCheckins += validCheckinsByRoute.get(routebook.publicId || routebook.title) ?? validCheckinsByRoute.get(routebook.title) ?? 0;
    item.favoriteCount += favoritesByRoute.get(routebook.publicId || routebook.title) ?? favoritesByRoute.get(routebook.title) ?? 0;
    item.predictionScoreTotal += Number(routebook.trustScore ?? 0);
    map.set(creator.id, item);
  }
  return [...map.values()]
    .map(({ predictionScoreTotal, ...item }) => ({
      ...item,
      avgPredictionScore: item.routebookCount ? Math.round(predictionScoreTotal / item.routebookCount) : null
    }))
    .sort((a, b) => b.copyCount + b.validCheckins + b.favoriteCount + b.clickCount - (a.copyCount + a.validCheckins + a.favoriteCount + a.clickCount))
    .slice(0, 12);
}

function buildRecentActivity(groups) {
  const rows = [
    ...groups.aiLogs.map((item) => ({ type: 'AI 生成', title: item.outputTitle || item.city, detail: item.status, createdAt: item.createdAt })),
    ...groups.routebooks.map((item) => ({
      type: '路书',
      title: item.title,
      detail: `${item.city} · ${item.publishStatus || 'draft'}`,
      createdAt: item.updatedAt
    })),
    ...groups.checkins.map((item) => ({ type: '打卡', title: item.stopName, detail: item.arrival?.label || item.worth, createdAt: item.createdAt })),
    ...groups.imports.map((item) => ({
      type: '导入',
      title: item.platforms?.join('、') || '攻略来源',
      detail: `均分 ${item.averageTrust}`,
      createdAt: item.createdAt
    })),
    ...groups.clicks.map((item) => ({ type: '点击', title: item.productTitle, detail: item.provider, createdAt: item.createdAt })),
    ...groups.exposures.map((item) => ({
      type: '曝光',
      title: item.routeTitle || item.productTitle || item.itemId,
      detail: item.surface,
      createdAt: item.createdAt
    }))
  ];
  return rows
    .filter((item) => item.createdAt)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, 20);
}

export async function buildCreatorProfile(creatorId) {
  const id = sanitizePublicId(creatorId);
  const [routebooks, checkins, favorites, clicks, exposures] = await Promise.all([
    listSavedRoutebooks(500, (routebook) => normalizeCreator(routebook.creator).id === id && PUBLIC_ROUTE_STATUSES.has(routebook.publishStatus || 'draft')),
    readJsonLines(CHECKIN_LOG_PATH, 1000),
    readJsonLines(FAVORITE_LOG_PATH, 1000),
    readJsonLines(CLICK_LOG_PATH, 1000),
    readJsonLines(EXPOSURE_LOG_PATH, 50000)
  ]);
  const owned = routebooks; // filtered to this creator's public routebooks during the scan
  const creator = owned[0]?.creator ? normalizeCreator(owned[0].creator) : normalizeCreator({ id, name: id });
  const stats = aggregateCreators(owned, checkins, favorites, clicks, exposures)[0] ?? {
    creator,
    routebookCount: owned.length,
    copyCount: 0,
    validCheckins: 0,
    favoriteCount: 0,
    clickCount: 0,
    avgPredictionScore: null
  };
  // rank23①：达人主页多本路书共用同一份反馈上下文，避免逐本重扫 JSONL。
  const feedbackContext = owned.length ? await buildRouteFeedbackContext() : null;
  return {
    creator,
    stats,
    routebooks: (await Promise.all(owned.map((routebook) => enrichRoutebook(routebook, feedbackContext)))).map(publicRoutebookView)
  };
}

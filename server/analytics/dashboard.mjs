// Ops dashboard, product analytics and creator profiles.
import { countBy, maxIso, sanitizePublicId, intersectSets, percent } from '../lib/util.mjs';
import { CLICK_LOG_PATH, EXPOSURE_LOG_PATH, AI_LOG_PATH, CHECKIN_LOG_PATH, FAVORITE_LOG_PATH, IMPORT_LOG_PATH, REVIEW_LOG_PATH, TRAVEL_DAY_TIME_ZONE, TRAVEL_DAY_WINDOW_DAYS, PUBLIC_ROUTE_STATUSES } from '../config/index.mjs';
import { readJsonLines } from '../storage/jsonl.mjs';
import { normalizeProfileId } from '../auth/tokens.mjs';
import { normalizeTravelDate, normalizeCreator } from '../routebooks/normalize.mjs';
import { isEligibleTrustCheckin, isTravelDateCheckin, isTravelDateEvent } from '../trust/checkins.mjs';
import { totalRoutebookCopyCount, routebookCopyCount } from '../routebooks/copies.mjs';
import { listSavedRoutebooks } from '../routebooks/list.mjs';
import { buildRouteFeedbackContext, enrichRoutebook } from '../trust/feedback.mjs';
import { publicRoutebookView } from '../routebooks/views.mjs';

export async function buildProductAnalytics(limit = 500, profileId = '') {
  const clicks = await readJsonLines(CLICK_LOG_PATH, Math.max(limit, 50));
  const exposures = await readJsonLines(EXPOSURE_LOG_PATH, Math.max(limit * 2, 100));
  const scopedClicks = profileId ? clicks.filter((click) => normalizeProfileId(click.profileId) === profileId) : clicks;
  const scopedExposures = profileId ? exposures.filter((item) => normalizeProfileId(item.profileId) === profileId) : exposures;
  const productExposures = scopedExposures.filter((item) => item.itemType === 'product' || item.productId);
  const aggregate = (keyFn, labelFn) => {
    const map = new Map();
    for (const click of scopedClicks) {
      const key = keyFn(click);
      if (!key) continue;
      const item = map.get(key) ?? { key, label: labelFn(click), count: 0 };
      item.count += 1;
      item.lastClickedAt = maxIso(item.lastClickedAt, click.createdAt);
      map.set(key, item);
    }
    return [...map.values()].sort((a, b) => b.count - a.count || String(b.lastClickedAt ?? '').localeCompare(String(a.lastClickedAt ?? ''))).slice(0, 12);
  };
  const exposureByProduct = countBy(productExposures, (item) => item.productId || item.itemId);
  const clickByProduct = countBy(scopedClicks, (item) => item.productId || item.productTitle);
  const ctrByProduct = [...exposureByProduct.entries()].map(([key, exposureCount]) => ({
    key,
    label: scopedExposures.find((item) => (item.productId || item.itemId) === key)?.productTitle ||
      scopedClicks.find((item) => (item.productId || item.productTitle) === key)?.productTitle ||
      key,
    exposureCount,
    clickCount: clickByProduct.get(key) ?? 0,
    ctr: exposureCount ? Math.round(((clickByProduct.get(key) ?? 0) / exposureCount) * 1000) / 10 : 0
  })).sort((a, b) => b.clickCount - a.clickCount || b.exposureCount - a.exposureCount).slice(0, 12);
  return {
    totalExposures: productExposures.length,
    totalClicks: scopedClicks.length,
    overallCtr: productExposures.length ? Math.round((scopedClicks.length / productExposures.length) * 1000) / 10 : null,
    topProducts: aggregate((click) => click.productId || click.productTitle, (click) => click.productTitle || '未知商品'),
    ctrByProduct,
    byProvider: aggregate((click) => click.provider, (click) => click.provider || '未知供应商'),
    byType: aggregate((click) => click.type, (click) => click.type || '未知类型'),
    byPoi: aggregate((click) => click.poi || click.stopName, (click) => click.poi || click.stopName || '未知 POI'),
    byRoute: aggregate((click) => click.routeId || click.routeTitle, (click) => click.routeTitle || click.routeId || '未知路书'),
    byProfile: aggregate((click) => click.profileId && click.profileId !== 'anonymous' ? click.profileId : '', (click) => click.profileId),
    recentClicks: scopedClicks.slice(0, 20)
  };
}

export function journeyKey(row = {}) {
  const profileId = normalizeProfileId(row?.profileId);
  const routeId = sanitizePublicId(row?.routeId || row?.publicId || row?.itemId);
  if (!routeId || !profileId || profileId === 'anonymous') return '';
  return `${profileId}::${routeId}`;
}

export function journeyRouteId(key) {
  return String(key ?? '').split('::')[1] || '';
}

export function journeyDateKey(row = {}) {
  const baseKey = journeyKey(row);
  const travelDate = normalizeTravelDate(row?.travelDate);
  return baseKey && travelDate ? `${baseKey}::${travelDate}` : '';
}

export function journeyBaseKeyFromDateKey(key) {
  return String(key ?? '').split('::').slice(0, 2).join('::');
}

export function journeyTravelDateFromKey(key) {
  return normalizeTravelDate(String(key ?? '').split('::')[2]);
}

export function distinctJourneyKeys(rows) {
  return new Set((rows ?? []).map(journeyKey).filter(Boolean));
}

export function distinctJourneyDateKeys(rows) {
  return new Set((rows ?? []).map(journeyDateKey).filter(Boolean));
}

export function indexJourneyDatesByBase(dateKeys) {
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

export async function buildPlatformDashboard(limit = 1000) {
  const [aiLogs, routebooks, checkins, favorites, reviews, imports, clicks, exposures] = await Promise.all([
    readJsonLines(AI_LOG_PATH, limit),
    listSavedRoutebooks(Math.min(limit, 500)),
    readJsonLines(CHECKIN_LOG_PATH, limit),
    readJsonLines(FAVORITE_LOG_PATH, limit),
    readJsonLines(REVIEW_LOG_PATH, limit),
    readJsonLines(IMPORT_LOG_PATH, limit),
    readJsonLines(CLICK_LOG_PATH, limit),
    readJsonLines(EXPOSURE_LOG_PATH, limit)
  ]);
  const generatedOk = aiLogs.filter((item) => item.kind === 'generate-routebook' && item.status === 'ok').length;
  const generateAttempts = aiLogs.filter((item) => item.kind === 'generate-routebook').length;
  const generatedRouteIds = new Set(aiLogs
    .filter((item) => item.kind === 'generate-routebook' && item.status === 'ok')
    .map((item) => sanitizePublicId(item.publicId))
    .filter(Boolean));
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
  const travelDayOpenedJourneyKeys = distinctJourneyDateKeys(tripOpenEvents.filter((event) => {
    const dateKey = journeyDateKey(event);
    return Boolean(
      dateKey &&
      savedDatedJourneyKeys.has(dateKey) &&
      isTravelDateEvent(journeyTravelDateFromKey(dateKey), event)
    );
  }));
  const effectiveExecutedJourneyKeys = intersectSets(travelDayOpenedJourneyKeys, validCheckinDatedJourneyKeys);
  const openedJourneyKeys = new Set([...tripOpenJourneyKeys, ...validCheckinKeys]);
  const savedOpenedJourneyKeys = intersectSets(openedJourneyKeys, savedJourneyKeys);
  const sharedJourneyKeys = distinctJourneyKeys(journeyEvents.filter((item) => item.surface === 'routebook-share'));
  const savedSharedJourneyKeys = intersectSets(sharedJourneyKeys, savedJourneyKeys);
  const savedGeneratedRouteIds = new Set([...savedJourneyKeys]
    .map(journeyRouteId)
    .filter((routeId) => generatedRouteIds.has(routeId)));
  const editedJourneyKeys = new Set([...savedJourneyKeys].filter((key) => {
    const routebook = routebooksById.get(journeyRouteId(key));
    return Boolean(routebook?.provider?.editedAt || routebook?.provider?.statusUpdatedAt || routebook?.activeVariantId);
  }));
  const recordedImportSources = imports
    .flatMap((item) => Array.isArray(item?.sources) ? item.sources : [])
    .filter((source) => ['fetched', 'metadata-only', 'failed'].includes(source?.status));
  const importAnalysisSucceeded = recordedImportSources.filter((source) => source.status === 'fetched').length;
  const importAnalysisFailed = recordedImportSources.length - importAnalysisSucceeded;
  const savedRoutebooks = savedJourneyKeys.size;
  const validCheckins = eligibleExecutionCheckins.length;
  const sharedRoutebooks = savedSharedJourneyKeys.size;
  const editedRoutebooks = editedJourneyKeys.size;
  const legacyJourneyEventsMissingTravelDate = journeyEvents.filter((item) => !normalizeTravelDate(item?.travelDate)).length;
  const copiedCount = totalRoutebookCopyCount(exposures);
  const productAnalytics = await buildProductAnalytics(limit);
  const funnel = {
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
    clickThroughRate: productAnalytics.overallCtr
  };
  return {
    funnel,
    metricDefinitions: {
      tripDayOpen: {
        numerator: '保存事件冻结的 profileId + routeId + travelDate，与同日期快照的 trip-open 关联，且打开时间在该日期前后 1 天',
        denominator: '保存事件中带有效 travelDate 快照的 profileId + routeId + travelDate 组合；缺失快照的历史事件不回填',
        timezone: TRAVEL_DAY_TIME_ZONE,
        windowDaysBefore: TRAVEL_DAY_WINDOW_DAYS,
        windowDaysAfter: TRAVEL_DAY_WINDOW_DAYS
      },
      effectiveExecution: {
	        numerator: '已保存且同日期快照在出行日前后 1 天打开，并由同一绑定身份与路书在该日期前后 1 天产生 visited + 有效 GPS 到达的 profileId + routeId + travelDate 组合',
	        denominator: '保存事件中带有效 travelDate 快照的 profileId + routeId + travelDate 组合；缺失快照的历史事件不回填',
	        timezone: TRAVEL_DAY_TIME_ZONE,
	        windowDaysBefore: TRAVEL_DAY_WINDOW_DAYS,
	        windowDaysAfter: TRAVEL_DAY_WINDOW_DAYS
      },
      importAnalysis: {
        numerator: '状态为 fetched 的已记录来源',
        denominator: '明确记录为 fetched、metadata-only 或 failed 的来源'
      }
    },
    byCity: aggregateRoutebooksByCity(routebooks, checkins),
    topCreators: aggregateCreators(routebooks, checkins, favorites, clicks, exposures),
    productAnalytics,
    recentActivity: buildRecentActivity({ aiLogs, routebooks, checkins, favorites, reviews, imports, clicks, exposures })
  };
}

export function aggregateRoutebooksByCity(routebooks, checkins) {
  const checkinsByCity = countBy(checkins, (item) => item.city);
  const map = new Map();
  for (const routebook of routebooks) {
    const city = routebook.city || '未知城市';
    const item = map.get(city) ?? { city, routebookCount: 0, featuredCount: 0, predictionScoreTotal: 0, validCheckins: checkinsByCity.get(city) ?? 0 };
    item.routebookCount += 1;
    if (routebook.publishStatus === 'featured') item.featuredCount += 1;
    item.predictionScoreTotal += Number(routebook.trustScore ?? 0);
    map.set(city, item);
  }
  return [...map.values()].map(({ predictionScoreTotal, ...item }) => ({
    ...item,
    avgPredictionScore: item.routebookCount ? Math.round(predictionScoreTotal / item.routebookCount) : null
  })).sort((a, b) => b.routebookCount - a.routebookCount).slice(0, 12);
}

export function aggregateCreators(routebooks, checkins = [], favorites = [], clicks = [], exposures = []) {
  const validCheckinsByRoute = countBy(checkins.filter((item) => item.arrival?.valid), (item) => item.routeId || item.routeTitle);
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
  return [...map.values()].map(({ predictionScoreTotal, ...item }) => ({
    ...item,
    avgPredictionScore: item.routebookCount ? Math.round(predictionScoreTotal / item.routebookCount) : null
  })).sort((a, b) => (b.copyCount + b.validCheckins + b.favoriteCount + b.clickCount) - (a.copyCount + a.validCheckins + a.favoriteCount + a.clickCount)).slice(0, 12);
}

export function buildRecentActivity(groups) {
  const rows = [
    ...groups.aiLogs.map((item) => ({ type: 'AI 生成', title: item.outputTitle || item.city, detail: item.status, createdAt: item.createdAt })),
    ...groups.routebooks.map((item) => ({ type: '路书', title: item.title, detail: `${item.city} · ${item.publishStatus || 'draft'}`, createdAt: item.updatedAt })),
    ...groups.checkins.map((item) => ({ type: '打卡', title: item.stopName, detail: item.arrival?.label || item.worth, createdAt: item.createdAt })),
    ...groups.imports.map((item) => ({ type: '导入', title: item.platforms?.join('、') || '攻略来源', detail: `均分 ${item.averageTrust}`, createdAt: item.createdAt })),
    ...groups.clicks.map((item) => ({ type: '点击', title: item.productTitle, detail: item.provider, createdAt: item.createdAt })),
    ...groups.exposures.map((item) => ({ type: '曝光', title: item.routeTitle || item.productTitle || item.itemId, detail: item.surface, createdAt: item.createdAt }))
  ];
  return rows
    .filter((item) => item.createdAt)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, 20);
}

export async function buildCreatorProfile(creatorId) {
  const id = sanitizePublicId(creatorId);
  const [routebooks, checkins, favorites, clicks, exposures] = await Promise.all([
    listSavedRoutebooks(500, (routebook) =>
      normalizeCreator(routebook.creator).id === id &&
      PUBLIC_ROUTE_STATUSES.has(routebook.publishStatus || 'draft')),
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

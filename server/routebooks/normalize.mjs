// Routebook normalisation, validation, metrics and curated routebooks.
import { createHmac } from 'node:crypto';
import {
  sanitizePublicId,
  truncateString,
  clampNumber,
  parseMoney,
  isValidCoordinate,
  distanceMeters,
  positiveInteger,
  normalizeRoutebookActorType,
  createHttpError,
  normalizeCityName
} from '../lib/util.mjs';
import { safeSourceUrl } from '../lib/urls.mjs';
import {
  PROFILE_ID_SECRET,
  MAX_ROUTEBOOK_STOPS,
  PUBLIC_ROUTE_STATUSES,
  MAX_IMPORT_URLS,
  ROUTEBOOK_STATUSES,
  CURATED_ROUTE_VERSION,
  CURATED_ROUTE_IDS
} from '../config/index.mjs';
import { safeEqualHex, cryptoRandomId, normalizeProfileId, sanitizeEditToken } from '../auth/tokens.mjs';
import { findTrustedPoi, resolvePoiId } from '../poi/catalog.mjs';
import { normalizeCoordinate } from '../geo/normalize-coordinate.mjs';
import { curatedRoutes, curatedRouteToRoutebook } from '../../src/lib/content.js';
import { getSavedRoutebook } from '../storage/records.mjs';

export function normalizeCreator(input = {}) {
  return {
    id: sanitizePublicId(input?.id || input?.creatorId) || 'official-curation',
    name: truncateString(input?.name || input?.creatorName, 60) || '可信路书编辑部',
    avatar: truncateString(input?.avatar || input?.creatorAvatar, 500),
    bio: truncateString(input?.bio || input?.creatorBio, 140),
    sourceAuthorization: truncateString(input?.sourceAuthorization || input?.authorization, 40) || 'self-owned'
  };
}

function importedSourceProofPayload(source = {}) {
  return [
    safeSourceUrl(source?.url),
    safeSourceUrl(source?.finalUrl),
    truncateString(source?.platform, 40),
    truncateString(source?.platformId, 40),
    truncateString(source?.status, 30),
    truncateString(source?.title, 120),
    truncateString(source?.description, 260),
    truncateString(source?.excerpt, 700),
    clampNumber(source?.trustScore, 0, 100, 20),
    (Array.isArray(source?.signals) ? source.signals : [])
      .slice(0, 5)
      .map((item) => truncateString(item, 80))
      .join(';'),
    (Array.isArray(source?.warnings) ? source.warnings : [])
      .slice(0, 5)
      .map((item) => truncateString(item, 100))
      .join(';'),
    truncateString(source?.fetchedAt, 60)
  ].join('|');
}

export function signImportedSource(source = {}) {
  return createHmac('sha256', PROFILE_ID_SECRET).update(importedSourceProofPayload(source)).digest('hex');
}

function hasValidImportedSourceProof(source = {}) {
  return safeEqualHex(String(source?.proof ?? ''), signImportedSource(source));
}

export function buildRoutebookMetrics(stops, existingMetrics = []) {
  const metrics = Array.isArray(existingMetrics) ? existingMetrics : [];
  const stopCount = stops.length;
  const lowGeoCount = stops.filter((stop) => Number(stop.geoConfidence ?? 0) < 60).length;
  const avgScore = stopCount ? Math.round(stops.reduce((sum, stop) => sum + Number(stop.score ?? 78), 0) / stopCount) : 78;
  const estimatedBudget = stops.reduce((sum, stop) => sum + parseMoney(stop.cost), 0);
  const calculated = [
    { label: '站点均分', value: `${avgScore}` },
    { label: '定位待复核', value: lowGeoCount ? `${lowGeoCount} 处` : '0 处' },
    { label: '预算估算', value: estimatedBudget ? `约 ${estimatedBudget} 元` : '待验证' },
    { label: '编辑校验', value: '已重算' }
  ];
  const merged = [...calculated, ...metrics.filter((item) => !calculated.some((next) => next.label === item.label))];
  return merged.slice(0, 6);
}

export function buildSourceSummary(sources = []) {
  const normalized = normalizeImportedSources(sources);
  if (!normalized.length) {
    return {
      sourceCount: 0,
      averageTrust: null,
      platforms: [],
      warnings: [],
      signals: []
    };
  }
  const averageTrust = Math.round(normalized.reduce((sum, source) => sum + source.trustScore, 0) / normalized.length);
  return {
    sourceCount: normalized.length,
    averageTrust,
    platforms: [...new Set(normalized.map((source) => source.platform).filter(Boolean))],
    warnings: [...new Set(normalized.flatMap((source) => source.warnings ?? []))].slice(0, 8),
    signals: [...new Set(normalized.flatMap((source) => source.signals ?? []))].slice(0, 8)
  };
}

function normalizeSourceSummary(summary, sources = []) {
  return buildSourceSummary(sources);
}

function mergeSourceMetrics(metrics, sourceSummary) {
  if (!sourceSummary?.sourceCount) return metrics;
  const sourceMetrics = [
    { label: '导入来源', value: `${sourceSummary.sourceCount} 条` },
    { label: '来源均分', value: `${sourceSummary.averageTrust}` }
  ];
  return [...sourceMetrics, ...metrics.filter((item) => !sourceMetrics.some((next) => next.label === item.label))].slice(0, 6);
}

function mergeSourceValidations(validations, sourceSummary) {
  if (!sourceSummary?.sourceCount) return validations;
  const state = sourceSummary.averageTrust >= 70 ? '可参考' : sourceSummary.averageTrust >= 45 ? '需复核' : '低可信';
  const detail = [
    `已分析 ${sourceSummary.sourceCount} 条导入来源，平均可信 ${sourceSummary.averageTrust}。`,
    sourceSummary.platforms?.length ? `平台：${sourceSummary.platforms.join('、')}。` : '',
    sourceSummary.warnings?.[0] ? `首要风险：${sourceSummary.warnings[0]}` : ''
  ]
    .filter(Boolean)
    .join('');
  const sourceValidation = {
    id: 'source-trust',
    label: '导入来源',
    state,
    detail: truncateString(detail, 120)
  };
  return [sourceValidation, ...validations.filter((item) => item.id !== 'source-trust')].slice(0, 8);
}

export function calculateRouteTrustScore(stops) {
  if (!stops.length) return 60;
  const avgPoiScore = stops.reduce((sum, stop) => sum + clampNumber(stop.score, 40, 99, 78), 0) / stops.length;
  const lowGeoPenalty = stops.filter((stop) => Number(stop.geoConfidence ?? 0) < 60).length * 3;
  const missingCostPenalty = stops.filter((stop) => !/\d/.test(String(stop.cost ?? ''))).length * 1.5;
  const denseDayPenalty =
    Math.max(
      0,
      Math.max(
        ...Object.values(
          stops.reduce((acc, stop) => {
            const day = stop.day || 'Day 1';
            acc[day] = (acc[day] ?? 0) + 1;
            return acc;
          }, {})
        )
      ) - 6
    ) * 2;
  return Math.round(clampNumber(avgPoiScore - lowGeoPenalty - missingCostPenalty - denseDayPenalty, 45, 96, 78));
}

export function hasPreciseCoordinate(stop) {
  return (
    isValidCoordinate(Number(stop?.lat), Number(stop?.lng)) &&
    Number(stop?.geoConfidence ?? 0) >= 60 &&
    stop?.navigationDisabled !== true &&
    !['city-center', 'region-center', 'country-center'].includes(String(stop?.coordinateSource ?? ''))
  );
}

function routeLegStats(stops) {
  let longestMeters = 0;
  let totalMeters = 0;
  let measuredLegs = 0;
  let unverifiedLegs = 0;
  const riskyLegs = [];
  for (let index = 0; index < stops.length - 1; index += 1) {
    const current = stops[index];
    const next = stops[index + 1];
    if ((current.day || 'Day 1') !== (next.day || 'Day 1')) continue;
    if (!hasPreciseCoordinate(current) || !hasPreciseCoordinate(next)) {
      unverifiedLegs += 1;
      continue;
    }
    const distance = distanceMeters(current, next);
    if (!Number.isFinite(distance)) {
      unverifiedLegs += 1;
      continue;
    }
    measuredLegs += 1;
    totalMeters += distance;
    if (distance > longestMeters) longestMeters = distance;
    if (distance > 8000) {
      riskyLegs.push({
        from: truncateString(current.name, 48),
        to: truncateString(next.name, 48),
        distance
      });
    }
  }
  return { longestMeters, totalMeters, measuredLegs, unverifiedLegs, riskyLegs };
}

// Day labels are relative ("Day 2"), so a closure check needs the travel date to know
// which weekday each stop actually lands on.
function weekdayForDayLabel(travelDate, dayLabel) {
  if (!travelDate) return null;
  const offset = Math.max(0, (Number(String(dayLabel ?? '').match(/\d+/)?.[0]) || 1) - 1);
  const timestamp = Date.parse(`${travelDate}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp + offset * 86400000).getUTCDay();
}

const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function poiOpenHours(stop, city) {
  const trusted = findTrustedPoi(stop, city);
  const hours = trusted?.openHours;
  if (!hours || !Array.isArray(hours.closedWeekdays)) return null;
  return hours;
}

function openingHoursConflicts(stops, city, travelDate) {
  const closures = [];
  let checkedStops = 0;
  let unknownStops = 0;
  for (const stop of stops) {
    const hours = poiOpenHours(stop, city);
    if (!hours) {
      unknownStops += 1;
      continue;
    }
    checkedStops += 1;
    const weekday = weekdayForDayLabel(travelDate, stop.day);
    if (weekday == null || !hours.closedWeekdays.includes(weekday)) continue;
    closures.push({
      name: truncateString(stop.name, 48),
      day: truncateString(stop.day, 24) || 'Day 1',
      weekday: WEEKDAY_NAMES[weekday],
      note: truncateString(hours.note, 60)
    });
  }
  return { closures, checkedStops, unknownStops };
}

function buildOpeningHoursValidation(stops, city, travelDate) {
  const { closures, checkedStops, unknownStops } = openingHoursConflicts(stops, city, travelDate);
  if (closures.length) {
    const first = closures[0];
    return {
      id: 'edit-hours',
      label: '营业时间',
      state: '闭馆冲突',
      detail: `${first.day}（${first.weekday}）${first.name}${first.note ? ` ${first.note}` : '当天不开放'}，请换到其他日期或替换同区 POI。${closures.length > 1 ? `另有 ${closures.length - 1} 处冲突。` : ''}`
    };
  }
  if (!travelDate) {
    return {
      id: 'edit-hours',
      label: '营业时间',
      state: '需填出行日期',
      detail: '填写出行日期后可自动检查闭馆冲突（例如周一闭馆的美术馆）。'
    };
  }
  if (!checkedStops) {
    return {
      id: 'edit-hours',
      label: '营业时间',
      state: '无数据',
      detail: `${unknownStops} 个站点没有已核验的营业时间数据，出发前需逐个复核。`
    };
  }
  return {
    id: 'edit-hours',
    label: '营业时间',
    state: unknownStops ? '部分待复核' : '通过',
    detail: unknownStops
      ? `已核对 ${checkedStops} 个站点当天开放，另有 ${unknownStops} 个站点缺营业时间数据需复核。`
      : `已核对 ${checkedStops} 个站点在出行日均开放。`
  };
}

// Budget is only meaningful against what the user asked for: "人均 300" and "人均 3000"
// cannot share one threshold.
function budgetThresholdFromConstraints(constraints, stops) {
  const perPerson = parseMoney(constraints?.budget);
  if (!perPerson) return { threshold: 0, perPerson: 0 };
  const dayCount = Math.max(1, new Set(stops.map((stop) => stop.day || 'Day 1')).size);
  return { threshold: perPerson * dayCount, perPerson };
}

function buildBudgetValidation(budget, constraints, stops) {
  if (!budget) {
    return { id: 'edit-budget', label: '预算风险', state: '待补充', detail: '费用信息不足，建议补充门票/餐饮价格。' };
  }
  const { threshold, perPerson } = budgetThresholdFromConstraints(constraints, stops);
  if (!threshold) {
    return {
      id: 'edit-budget',
      label: '预算风险',
      state: '无预算约束',
      detail: `按站点费用粗估约 ${budget} 元，填写预算后可判断是否超支。`
    };
  }
  const overspent = budget > threshold;
  return {
    id: 'edit-budget',
    label: '预算风险',
    state: overspent ? '超预算' : '可控',
    detail: `按站点费用粗估约 ${budget} 元，你的预算为人均 ${perPerson} 元（约 ${threshold} 元）。${overspent ? `超出约 ${budget - threshold} 元，建议替换高价站点。` : '实际价格仍需出发前复核。'}`
  };
}

export function buildRoutebookValidations(stops, existingValidations = [], reason = '保存', context = {}) {
  const validations = Array.isArray(existingValidations) ? existingValidations : [];
  const groupedByDay = stops.reduce((map, stop) => {
    const day = stop.day || 'Day 1';
    map.set(day, (map.get(day) ?? 0) + 1);
    return map;
  }, new Map());
  const crowdedDay = [...groupedByDay.entries()].find(([, count]) => count > 6);
  const missingCoordinate = stops.filter((stop) => !isValidCoordinate(Number(stop.lat), Number(stop.lng))).length;
  const lowConfidence = stops.filter((stop) => Number(stop.geoConfidence ?? 0) < 60).length;
  const budget = stops.reduce((sum, stop) => sum + parseMoney(stop.cost), 0);
  const legStats = routeLegStats(stops);
  const measuredDistanceKm = legStats.totalMeters ? (legStats.totalMeters / 1000).toFixed(1) : '';
  const calculated = [
    {
      id: 'edit-routing',
      label: '编辑后动线',
      state: missingCoordinate || legStats.unverifiedLegs ? '需复核' : '已更新',
      detail: `${reason}后已重算站点顺序；${missingCoordinate ? `${missingCoordinate} 个站点缺少可用坐标。` : legStats.unverifiedLegs ? `${legStats.unverifiedLegs} 段因定位待复核未计算精确转场。` : `已计算 ${legStats.measuredLegs} 段转场，合计约 ${measuredDistanceKm} km。`}`
    },
    {
      id: 'edit-tempo',
      label: '节奏密度',
      state: crowdedDay ? '偏紧' : '可执行',
      detail: crowdedDay ? `${crowdedDay[0]} 有 ${crowdedDay[1]} 站，建议拆分或删减。` : '单日站点密度在 MVP 可执行范围内。'
    },
    {
      id: 'edit-detour',
      label: '绕路风险',
      state: legStats.riskyLegs.length ? '需重排' : legStats.unverifiedLegs ? '待复核' : '可执行',
      detail: legStats.riskyLegs.length
        ? `${legStats.riskyLegs[0].from} → ${legStats.riskyLegs[0].to} 约 ${(legStats.riskyLegs[0].distance / 1000).toFixed(1)} km，建议拆天或替换同区 POI。`
        : legStats.unverifiedLegs
          ? `${legStats.unverifiedLegs} 段缺少高置信坐标，暂不输出精确步行/打车时长。`
          : `最长相邻转场约 ${(legStats.longestMeters / 1000).toFixed(1)} km。`
    },
    buildBudgetValidation(budget, context.constraints, stops),
    buildOpeningHoursValidation(stops, context.city, context.travelDate),
    {
      id: 'edit-geo',
      label: '定位可信',
      state: lowConfidence ? '需复核' : '通过',
      detail: lowConfidence ? `${lowConfidence} 个站点为低置信定位，仅展示街区/城市级范围，不开放一键导航。` : '站点定位置信度满足当前展示要求。'
    }
  ];
  const merged = [...calculated, ...validations.filter((item) => !calculated.some((next) => next.id === item.id))];
  return merged.slice(0, 8);
}

function normalizeRoutebookStop(stop, index, city) {
  const coordinate = normalizeCoordinate(stop, city, index);
  const name = truncateString(stop?.name, 48) || `站点 ${index + 1}`;
  const poiId = resolvePoiId({ ...stop, name }, city);
  const existingId = stop?.id;
  const stableStopId = typeof existingId === 'number' && Number.isFinite(existingId) ? existingId : sanitizePublicId(existingId) || `stop-${index + 1}`;
  return {
    id: stableStopId,
    poiId,
    day: truncateString(stop?.day, 24) || 'Day 1',
    time: truncateString(stop?.time, 24) || '10:00',
    name,
    area: truncateString(stop?.area, 40) || '待确认',
    stay: truncateString(stop?.stay, 24) || '60 分钟',
    cost: truncateString(stop?.cost, 32) || '待估算',
    verify: truncateString(stop?.verify, 120) || '需通过真实打卡继续验证',
    risk: truncateString(stop?.risk, 120) || '需出发前复核',
    score: clampNumber(stop?.score, 40, 99, 78),
    lat: coordinate.lat,
    lng: coordinate.lng,
    geoConfidence:
      coordinate.fallback || coordinate.navigationDisabled === true
        ? clampNumber(coordinate.confidence, 20, 59, 45)
        : clampNumber(stop?.geoConfidence, 60, 99, coordinate.confidence ?? 82),
    coordinateSystem: 'WGS84',
    coordinateSource: truncateString(stop?.coordinateSource, 40) || coordinate.source,
    coordinatePrecision: truncateString(stop?.coordinatePrecision, 40) || coordinate.precision,
    coordinateRadiusMeters:
      coordinate.fallback || coordinate.navigationDisabled === true
        ? clampNumber(coordinate.radiusMeters, 400, 1000000, 1500)
        : clampNumber(stop?.coordinateRadiusMeters, 0, 1000000, coordinate.radiusMeters ?? 0),
    navigationDisabled: stop?.navigationDisabled === true || coordinate.navigationDisabled === true,
    sourceEvidence: normalizeStopEvidence(stop?.sourceEvidence),
    facts: normalizeStopFacts(stop?.facts)
  };
}

export function normalizeStopEvidence(items = []) {
  if (!Array.isArray(items)) return [];
  return items
    .slice(0, 5)
    .map((item, index) => ({
      id: sanitizePublicId(item?.id) || `evidence-${index + 1}`,
      type: truncateString(item?.type, 32) || 'source',
      label: truncateString(item?.label, 80) || '来源证据',
      detail: truncateString(item?.detail, 220),
      platform: truncateString(item?.platform, 40),
      trustScore: item?.trustScore == null ? null : clampNumber(item.trustScore, 0, 100, 50),
      url: safeSourceUrl(item?.url),
      checkedAt: truncateString(item?.checkedAt, 60)
    }))
    .filter((item) => item.label || item.detail || item.url);
}

export function normalizeStopFacts(items = []) {
  if (!Array.isArray(items)) return [];
  return items
    .slice(0, 8)
    .map((item, index) => ({
      id: sanitizePublicId(item?.id) || `fact-${index + 1}`,
      field: truncateString(item?.field, 40) || '综合信息',
      value: truncateString(item?.value, 180),
      confidence: clampNumber(item?.confidence, 0, 100, 60),
      sourceLabel: truncateString(item?.sourceLabel, 80),
      sourceType: truncateString(item?.sourceType, 32) || 'derived',
      sourceUrl: safeSourceUrl(item?.sourceUrl),
      status: truncateString(item?.status, 24) || '需复核',
      checkedAt: truncateString(item?.checkedAt, 60)
    }))
    .filter((item) => item.field && item.value);
}

export function routebookValidationContext(routebook) {
  return {
    city: routebook?.city,
    constraints: routebook?.constraints,
    travelDate: resolveTravelDate(routebook?.travelDate, routebook?.constraints?.date, routebook?.provider?.travelDate)
  };
}

export function normalizeRouteVariant(variant, index, city, fallbackStops = [], context = {}) {
  const mode = truncateString(variant?.mode, 24) || '自定义';
  const sourceStops = Array.isArray(variant?.stops) && variant.stops.length ? variant.stops : fallbackStops;
  const stops = sourceStops.slice(0, MAX_ROUTEBOOK_STOPS).map((stop, stopIndex) => normalizeRoutebookStop(stop, stopIndex, city));
  if (stops.length < 2) return null;
  const id = sanitizePublicId(variant?.id) || cryptoRandomId();
  const days = [...new Set(stops.map((stop) => stop.day || 'Day 1'))];
  return {
    id,
    mode,
    label: truncateString(variant?.label, 40) || `${mode}版`,
    summary: truncateString(variant?.summary, 160) || `按${mode}偏好重排，并保留原路书的可信校验。`,
    days,
    stops,
    trustScore: calculateRouteTrustScore(stops),
    metrics: buildRoutebookMetrics(stops, variant?.metrics),
    validations: buildRoutebookValidations(stops, variant?.validations, `${mode}变体`, { city, ...(context ?? {}) }),
    createdAt: truncateString(variant?.createdAt, 60) || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

export function normalizeRouteVariants(variants, city, fallbackStops = [], context = {}) {
  if (!Array.isArray(variants)) return [];
  const latestByKey = new Map();
  variants
    .slice(0, 12)
    .map((variant, index) => normalizeRouteVariant(variant, index, city, fallbackStops, context))
    .filter(Boolean)
    .forEach((variant) => {
      latestByKey.set(variant.id || variant.mode, variant);
    });
  return [...latestByKey.values()].slice(0, 8);
}

function routebookVersionMetadata(input, now, publishStatus) {
  const version = positiveInteger(input?.version, 1);
  const parentVersion = positiveInteger(input?.parentVersion);
  const createdAt = truncateString(input?.createdAt, 60) || now.toISOString();
  const existingPublishedAt = truncateString(input?.publishedAt, 60);
  const existingArchivedAt = truncateString(input?.archivedAt, 60);
  return {
    schemaVersion: positiveInteger(input?.schemaVersion, 2),
    version,
    parentVersion: parentVersion != null && parentVersion < version ? parentVersion : null,
    createdAt,
    updatedAt: now.toISOString(),
    publishedAt: PUBLIC_ROUTE_STATUSES.has(publishStatus) ? existingPublishedAt || now.toISOString() : existingPublishedAt,
    archivedAt: publishStatus === 'archived' ? existingArchivedAt || now.toISOString() : '',
    changeReason: truncateString(input?.changeReason || input?.editReason, 160) || (version === 1 ? '创建路书' : '更新路书'),
    actorType: normalizeRoutebookActorType(input?.actorType || (input?.profileId ? 'user' : 'system'))
  };
}

export function normalizeRoutebookForStorage(input, existingId = '') {
  const city = normalizeCityName(input?.city);
  const now = new Date();
  const stops = (Array.isArray(input?.stops) ? input.stops : []).slice(0, MAX_ROUTEBOOK_STOPS).map((stop, index) => normalizeRoutebookStop(stop, index, city));
  if (stops.length < 2) {
    throw createHttpError('路书至少需要 2 个站点才能保存', 400, 'ROUTEBOOK_TOO_SHORT');
  }
  const id = sanitizePublicId(existingId || input?.id || input?.publicId) || cryptoRandomId();
  const days =
    Array.isArray(input?.days) && input.days.length
      ? input.days
          .map((day) => truncateString(day, 24))
          .filter(Boolean)
          .slice(0, 10)
      : [...new Set(stops.map((stop) => stop.day || 'Day 1'))];
  const sourceSummary = normalizeSourceSummary(input?.sourceSummary, input?.importedSources);
  const validationContext = {
    city,
    constraints: input?.constraints,
    travelDate: resolveTravelDate(input?.travelDate, input?.constraints?.date, input?.provider?.travelDate)
  };
  const validations = mergeSourceValidations(
    buildRoutebookValidations(stops, input?.validations, input?.editReason || '保存', validationContext),
    sourceSummary
  );
  const metrics = mergeSourceMetrics(buildRoutebookMetrics(stops, input?.metrics), sourceSummary);
  const trustScore = calculateRouteTrustScore(stops);
  const publishStatus = ROUTEBOOK_STATUSES.has(input?.publishStatus) ? input.publishStatus : 'draft';
  const versionMetadata = routebookVersionMetadata(input, now, publishStatus);
  return {
    id,
    publicId: id,
    profileId: normalizeProfileId(input?.profileId),
    editToken: sanitizeEditToken(input?.editToken),
    creator: normalizeCreator(input?.creator),
    publishStatus,
    sourceAuthorization: truncateString(input?.sourceAuthorization || input?.creator?.sourceAuthorization, 40) || 'self-owned',
    copyCount: clampNumber(input?.copyCount, 0, 1000000, 0),
    city,
    title: truncateString(input?.title, 80) || `${city} 可信路书`,
    summary: truncateString(input?.summary, 220) || '已保存为可分享、可编辑的可信路书。',
    trustScore,
    days,
    stops,
    assets: Array.isArray(input?.assets)
      ? input.assets.slice(0, 12).map((item, index) => ({
          label: truncateString(item?.label, 30) || `资产 ${index + 1}`,
          type: truncateString(item?.type, 24) || 'POI',
          confidence: clampNumber(item?.confidence, 0, 99, 72)
        }))
      : [],
    validations,
    metrics,
    logs: normalizeLogs(input?.logs, now),
    importedSources: normalizeImportedSources(input?.importedSources).slice(0, MAX_IMPORT_URLS),
    sourceSummary,
    constraints: normalizeRouteConstraints(input?.constraints),
    travelDate: resolveTravelDate(input?.travelDate, input?.constraints?.date, input?.provider?.travelDate),
    variants: normalizeRouteVariants(input?.variants, city, stops, validationContext),
    activeVariantId: sanitizePublicId(input?.activeVariantId),
    provider: normalizeStoredProvider(input?.provider, {
      travelDate: resolveTravelDate(input?.travelDate, input?.constraints?.date, input?.provider?.travelDate),
      savedAt: now.toISOString()
    }),
    ...versionMetadata
  };
}

/**
 * @param {any} [provider]
 * @param {Record<string, any>} [extra]
 */
function normalizeStoredProvider(provider = {}, extra = {}) {
  const source = provider && typeof provider === 'object' ? provider : {};
  const normalized = {
    name: truncateString(source.name, 40),
    model: truncateString(source.model, 80),
    baseUrl: truncateString(source.baseUrl, 180),
    generatedAt: truncateString(source.generatedAt, 60),
    editedAt: truncateString(source.editedAt, 60),
    copiedAt: truncateString(source.copiedAt, 60),
    savedAt: truncateString(extra.savedAt || source.savedAt, 60),
    statusUpdatedAt: truncateString(source.statusUpdatedAt, 60),
    tokenMigratedAt: truncateString(source.tokenMigratedAt, 60),
    userPublishedAt: truncateString(source.userPublishedAt, 60),
    travelDate: normalizeTravelDate(extra.travelDate || source.travelDate)
  };
  return Object.fromEntries(Object.entries(normalized).filter(([, value]) => value !== ''));
}

export function normalizeRouteConstraints(input = {}) {
  return {
    duration: truncateString(input?.duration, 30),
    budget: truncateString(input?.budget, 30),
    tempo: truncateString(input?.tempo, 30),
    companion: truncateString(input?.companion, 30),
    date: normalizeTravelDate(input?.date),
    base: truncateString(input?.base, 80),
    transport: truncateString(input?.transport, 60),
    theme: truncateString(input?.theme, 120),
    mustGo: truncateString(input?.mustGo, 120),
    avoid: truncateString(input?.avoid, 120)
  };
}

export function normalizeTravelDate(value) {
  const text = truncateString(value, 30);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return '';
  const timestamp = Date.parse(`${text}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp)) return '';
  return new Date(timestamp).toISOString().slice(0, 10) === text ? text : '';
}

export function resolveTravelDate(...values) {
  for (const value of values) {
    const normalized = normalizeTravelDate(value);
    if (normalized) return normalized;
  }
  return '';
}

export function getCuratedRoutebook(publicId) {
  const id = sanitizePublicId(publicId);
  const source = curatedRoutes.find((route) => sanitizePublicId(route.id) === id);
  if (!source) return null;
  const normalized = normalizeRoutebookForStorage(
    {
      ...curatedRouteToRoutebook(source),
      schemaVersion: 2,
      version: 1,
      parentVersion: null,
      createdAt: CURATED_ROUTE_VERSION,
      publishedAt: CURATED_ROUTE_VERSION,
      changeReason: '编辑部精选初始版本',
      actorType: 'admin',
      profileId: 'official-curation',
      publishStatus: 'featured',
      sourceAuthorization: 'self-owned',
      creator: {
        id: 'official-curation',
        name: '可信路书编辑部',
        bio: '首批可信城市路线由编辑样板和真实打卡持续校准。',
        sourceAuthorization: 'self-owned'
      },
      provider: {
        name: 'curation',
        model: 'ops-template',
        generatedAt: CURATED_ROUTE_VERSION
      }
    },
    id
  );
  return {
    ...normalized,
    updatedAt: CURATED_ROUTE_VERSION,
    provider: {
      ...normalized.provider,
      generatedAt: CURATED_ROUTE_VERSION,
      savedAt: CURATED_ROUTE_VERSION
    }
  };
}

export async function getResolvableRoutebook(publicId) {
  return (await getSavedRoutebook(publicId)) ?? getCuratedRoutebook(publicId);
}

export function isCuratedRouteId(publicId) {
  return CURATED_ROUTE_IDS.has(sanitizePublicId(publicId));
}

export function normalizeImportedSources(sources) {
  if (!Array.isArray(sources)) return [];
  return sources
    .slice(0, MAX_IMPORT_URLS)
    .map((source) => {
      const normalized = {
        url: safeSourceUrl(source?.url),
        finalUrl: safeSourceUrl(source?.finalUrl),
        platform: truncateString(source?.platform, 40),
        platformId: truncateString(source?.platformId, 40),
        status: truncateString(source?.status, 30),
        title: truncateString(source?.title, 120),
        description: truncateString(source?.description, 260),
        excerpt: truncateString(source?.excerpt, 700),
        trustScore: clampNumber(source?.trustScore, 0, 100, 20),
        signals: Array.isArray(source?.signals) ? source.signals.slice(0, 5).map((item) => truncateString(item, 80)) : [],
        warnings: Array.isArray(source?.warnings) ? source.warnings.slice(0, 5).map((item) => truncateString(item, 100)) : [],
        fetchedAt: truncateString(source?.fetchedAt, 60),
        proof: String(source?.proof ?? '')
          .trim()
          .toLowerCase()
      };
      if (hasValidImportedSourceProof(normalized)) return normalized;
      return {
        ...normalized,
        trustScore: Math.min(20, normalized.trustScore),
        proof: '',
        warnings: [...new Set([...normalized.warnings, '来源可信度未由服务端签名'])].slice(0, 5)
      };
    })
    .filter((source) => source.url || source.excerpt || source.title);
}

export function normalizeLogs(logs, now) {
  const fallback = [
    { stage: '意图识别', input: '用户攻略与约束', result: '已提取城市、天数与偏好', status: '通过' },
    { stage: 'POI 提取', input: '攻略文本', result: '已识别候选地点', status: '通过' },
    { stage: '路线编排', input: '候选地点', result: '已按分日顺序编排', status: '通过' },
    { stage: '可执行校验', input: '路线与约束', result: '已标记需复核风险', status: '需复核' }
  ];
  const source = Array.isArray(logs) && logs.length ? logs : fallback;
  const normalized = source.slice(0, 8).map((log, index) => ({
    time: new Date(now.getTime() + index * 1000).toLocaleTimeString('zh-CN', { hour12: false }),
    input: String(log.input ?? '用户攻略与约束').slice(0, 32),
    stage: String(log.stage ?? `阶段 ${index + 1}`).slice(0, 18),
    result: String(log.result ?? '已完成').slice(0, 72),
    status: String(log.status ?? '通过').slice(0, 12)
  }));
  return normalized.length >= 4 ? normalized : [...normalized, ...fallback].slice(0, 4);
}

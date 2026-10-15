// Routebook normalisation, validation, metrics and curated routebooks.
import { createHmac } from 'node:crypto';
import {
  sanitizePublicId,
  truncateString,
  clampNumber,
  parseMoneyRange,
  isValidCoordinate,
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
import { routebookGuideOrigins } from '../../src/lib/importOrigins.js';
import { safeEqualHex, cryptoRandomId, normalizeProfileId, sanitizeEditToken, hashSecretToken } from '../auth/tokens.mjs';
import { findTrustedPoi, resolvePoiId } from '../poi/catalog.mjs';
import { normalizeCoordinate } from '../geo/normalize-coordinate.mjs';
import { curatedRoutes, curatedRouteToRoutebook } from '../../src/lib/content.js';
import { getSavedRoutebook } from '../storage/records.mjs';
import { normalizeStoredRouteLegs, normalizeStopTransportMode } from '../routing/provenance.mjs';
import { routeExecutionMetricRows, routeExecutionValidationRows, summarizeRouteExecution } from '../routing/routeExecution.mjs';
import { importSourceId } from '../ops/source-identity.mjs';
import { checkVisitWindow } from '../../src/lib/openingHours.js';
import { normalizeStopProvenance } from '../trust/provenance.mjs';
import { coordinateVerificationLevel, normalizePlaceText, placeNameVariants, routeEvidenceScore } from '../../src/lib/trustSignals.js';
import { formatCostInfo, stopCostInfo, sumStopCosts } from '../../src/lib/cost.js';
import { publicCreatorName } from '../../src/lib/creatorName.js';
import { suggestedCityFor } from '../ai/citySuggestion.mjs';

export { LEGACY_PLACEHOLDER_CREATOR_NAMES } from '../../src/lib/creatorName.js';

/** @returns {string | null} */
export function normalizeCreatorName(value) {
  return publicCreatorName(truncateString(value, 60));
}

export function normalizeCreator(input = {}) {
  return {
    id: sanitizePublicId(input?.id || input?.creatorId) || 'official-curation',
    name: normalizeCreatorName(input?.name || input?.creatorName),
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

export function buildRoutebookMetrics(stops, existingMetrics = [], routeLegs = []) {
  const metrics = Array.isArray(existingMetrics) ? existingMetrics : [];
  const stopCount = stops.length;
  const lowGeoCount = stops.filter((stop) => coordinateVerificationLevel(stop) !== 'verified').length;
  const evidence = routeEvidenceScore(stops);
  const budgetSummary = sumStopCosts(stops);
  const calculated = [
    ...routeExecutionMetricRows(summarizeRouteExecution(stops, routeLegs)),
    { label: '资料核对分', value: stopCount ? `${evidence.score}` : '—' },
    { label: '定位待复核', value: lowGeoCount ? `${lowGeoCount} 处` : '0 处' },
    { label: '预算估算', value: formatBudgetSummary(budgetSummary) },
    { label: '编辑校验', value: '已重算' }
  ];
  // Only system-computed metrics are kept; model-written metrics are dropped.
  void metrics;
  return calculated.slice(0, 9);
}

/** Metric labels the server computes itself (see buildRoutebookMetrics / mergeSourceMetrics). */
const SYSTEM_METRIC_LABELS = new Set([
  '道路核验',
  '路线已查',
  '道路距离',
  '道路耗时',
  '资料核对分',
  '定位待复核',
  '预算估算',
  '编辑校验',
  '导入来源',
  '来源均分'
]);

/** Hides model-written metrics on routebooks saved before they were dropped. */
export function systemMetrics(metrics) {
  return (Array.isArray(metrics) ? metrics : []).filter((item) => SYSTEM_METRIC_LABELS.has(String(item?.label ?? '')));
}

/** Validation ids produced by server code; anything else was written by a model. */
const CLIENT_ACTION_VALIDATION_ID = /^(?:mode-\d+|variant-apply-[a-z0-9-]+)$/i;

export const SYSTEM_VALIDATION_IDS = new Set([
  'edit-routing',
  'edit-tempo',
  'edit-detour',
  'edit-budget',
  'edit-hours',
  'edit-constraints',
  'edit-geo',
  'source-trust',
  'day-count-compressed'
]);

/** Hides model-written validation rows (e.g. "拥挤风险：通过") on older routebooks. */
export function systemValidations(validations) {
  // Client action notes ("已按…重排", "已应用变体") describe what the user did, not a check result.
  return (Array.isArray(validations) ? validations : []).filter((item) => {
    const id = String(item?.id ?? '');
    return SYSTEM_VALIDATION_IDS.has(id) || CLIENT_ACTION_VALIDATION_ID.test(id);
  });
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

/**
 * Evidence score (0-100) from verifiable per-stop signals only: provenance,
 * reviewed-catalog match, coordinate verification and reviewed facts with
 * evidence and expiry (see src/lib/trustSignals.js). The model's own `score`
 * is ignored. Routes without stops score 0.
 */
export function calculateRouteTrustScore(stops) {
  return routeEvidenceScore(stops).score ?? 0;
}

export function hasPreciseCoordinate(stop) {
  return (
    isValidCoordinate(Number(stop?.lat), Number(stop?.lng)) &&
    Number(stop?.geoConfidence ?? 0) >= 60 &&
    stop?.navigationDisabled !== true &&
    !['city-center', 'region-center', 'country-center'].includes(String(stop?.coordinateSource ?? ''))
  );
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

function parseTimestamp(value, endOfDay = false) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const timestamp = /^\d{4}-\d{2}-\d{2}$/.test(text) ? Date.parse(`${text}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`) : Date.parse(text);
  return Number.isFinite(timestamp) ? timestamp : null;
}

// Timing is known when the place is always open or we have an opening window;
// last entry is tracked separately (lastEntryKnown) so '通过' still needs it.
function hasScheduleTiming(hours) {
  if (hours?.alwaysOpen === true) return true;
  const hasOpeningTime = Boolean(hours?.openTime || hours?.openingTime);
  const hasClosingTime = Boolean(hours?.closeTime || hours?.closingTime);
  return hasOpeningTime && hasClosingTime;
}

function hasScheduleEvidence(hours, trusted) {
  // Seed closures are a conservative baseline used to flag an obvious
  // weekday conflict.  Operational hours must carry evidence before they can
  // be treated as planning facts.
  if (trusted?.sourceKind === 'seed') return true;
  return Boolean(hours?.evidence || hours?.evidenceId || hours?.sourceEvidence || hours?.checkedAt || hours?.verifiedAt);
}

export function normalizePoiOpenHours(hours, trusted, nowMs = Date.now()) {
  if (!hours || !Array.isArray(hours.closedWeekdays)) return null;
  const validUntil = hours.validUntil || hours.expiresAt || hours.expiry;
  const expiry = parseTimestamp(validUntil, true);
  const freshnessInvalid = Boolean(validUntil) && !Number.isFinite(expiry);
  // Operational facts must carry a validity window to be trusted for planning.
  const freshnessMissing = trusted?.sourceKind === 'operational' && !validUntil;
  const stale = freshnessInvalid || freshnessMissing || (Number.isFinite(expiry) && expiry < nowMs);
  const hasEvidence = hasScheduleEvidence(hours, trusted);
  const timingKnown = hasScheduleTiming(hours);
  return {
    ...hours,
    lastEntryKnown: hours.alwaysOpen === true || Boolean(hours.lastEntryTime || hours.latestEntryTime),
    stale,
    freshnessInvalid,
    hasEvidence,
    timingKnown,
    // A weekday closure can still be surfaced as a warning, but no schedule
    // lacking fresh evidence and an arrival window is planning-usable.
    planningUsable: !stale && hasEvidence && timingKnown,
    closureCheckable: !stale && hasEvidence
  };
}

function poiOpenHours(stop, city, nowMs = Date.now()) {
  const trusted = findTrustedPoi(stop, city);
  const hours = normalizePoiOpenHours(trusted?.openHours, trusted, nowMs);
  if (!hours) return null;
  return { hours, trusted };
}

function openingHoursConflicts(stops, city, travelDate, nowMs = Date.now()) {
  const closures = [];
  let checkedStops = 0;
  let unknownStops = 0;
  let timingUnknownStops = 0;
  let staleStops = 0;
  let evidenceMissingStops = 0;
  let arrivalUnknownStops = 0;
  let lastEntryUnknownStops = 0;
  const timeConflicts = [];
  for (const stop of stops) {
    const schedule = poiOpenHours(stop, city, nowMs);
    if (!schedule) {
      unknownStops += 1;
      continue;
    }
    const { hours } = schedule;
    checkedStops += 1;
    if (hours.stale) staleStops += 1;
    if (!hours.hasEvidence) evidenceMissingStops += 1;
    if (!hours.timingKnown) timingUnknownStops += 1;
    if (!hours.planningUsable) unknownStops += 1;
    if (hours.planningUsable) {
      const window = checkVisitWindow(
        {
          ...hours,
          openTime: hours.openTime || hours.openingTime,
          closeTime: hours.closeTime || hours.closingTime,
          lastEntryTime: hours.lastEntryTime || hours.latestEntryTime
        },
        stop.time,
        stop.stay
      );
      if (window.status === 'unknown') arrivalUnknownStops += 1;
      else if (window.status !== 'ok')
        timeConflicts.push({ name: truncateString(stop.name, 48), day: truncateString(stop.day, 24) || 'Day 1', status: window.status, detail: window.detail });
      else if (!window.lastEntryKnown) lastEntryUnknownStops += 1;
    }
    const weekday = weekdayForDayLabel(travelDate, stop.day);
    if (weekday == null || !hours.closureCheckable || !hours.closedWeekdays.includes(weekday)) continue;
    closures.push({
      name: truncateString(stop.name, 48),
      day: truncateString(stop.day, 24) || 'Day 1',
      weekday: WEEKDAY_NAMES[weekday],
      note: truncateString(hours.note, 60),
      planningUsable: hours.planningUsable,
      stale: hours.stale,
      hasEvidence: hours.hasEvidence
    });
  }
  return {
    closures,
    timeConflicts,
    checkedStops,
    unknownStops,
    timingUnknownStops,
    staleStops,
    evidenceMissingStops,
    arrivalUnknownStops,
    lastEntryUnknownStops
  };
}

export function buildOpeningHoursValidation(stops, city, travelDate, { nowMs = Date.now() } = {}) {
  const {
    closures,
    timeConflicts,
    checkedStops,
    unknownStops,
    timingUnknownStops,
    staleStops,
    evidenceMissingStops,
    arrivalUnknownStops,
    lastEntryUnknownStops
  } = openingHoursConflicts(stops, city, travelDate, nowMs);
  if (timeConflicts.length) {
    const first = timeConflicts[0];
    return {
      id: 'edit-hours',
      label: '营业时间',
      state: '时段冲突',
      detail: `${first.day} ${first.name}：${first.detail}。${timeConflicts.length > 1 ? `另有 ${timeConflicts.length - 1} 处时段冲突。` : ''}请调整到达时间或停留时长。`
    };
  }
  if (!travelDate) {
    return {
      id: 'edit-hours',
      label: '营业时间',
      state: '未核对',
      detail: '没有出行日期，系统没有检查闭馆冲突；填写日期后可检查。到达时段和最晚入场仍需有有效营业事实才能判断。'
    };
  }
  if (closures.length) {
    const first = closures[0];
    const conflictText = `${first.day}（${first.weekday}）${first.name}${first.note ? ` ${first.note}` : '当天不开放'}`;
    const suffix = closures.length > 1 ? `另有 ${closures.length - 1} 处冲突。` : '';
    if (!first.planningUsable) {
      return {
        id: 'edit-hours',
        label: '营业时间',
        state: '需复核',
        detail: `发现${conflictText}的闭馆信号，但营业事实${first.stale ? '已过期或有效期无效' : '缺少有效证据'}，不能作为规划可用条件；${suffix}请出发前确认。`
      };
    }
    return {
      id: 'edit-hours',
      label: '营业时间',
      state: '闭馆冲突',
      detail: `${conflictText}，请换到其他日期或替换同区 POI。${suffix}`
    };
  }
  if (!checkedStops) {
    return {
      id: 'edit-hours',
      label: '营业时间',
      state: '未核对',
      detail: `${unknownStops} 个站点没有带证据的营业时间数据，系统没有核对开放时段；出发前需逐个确认到达时段和最晚入场。`
    };
  }
  if (staleStops || evidenceMissingStops) {
    return {
      id: 'edit-hours',
      label: '营业时间',
      state: '部分待复核',
      detail: `已有营业日历信号，但 ${staleStops ? `${staleStops} 个站点事实已过期或有效期无效` : ''}${staleStops && evidenceMissingStops ? '，' : ''}${evidenceMissingStops ? `${evidenceMissingStops} 个站点缺少有效证据` : ''}；不能作为规划可用条件。到达时段/最晚入场未知。`
    };
  }
  if (timingUnknownStops || unknownStops || arrivalUnknownStops || lastEntryUnknownStops) {
    const gaps = [
      unknownStops ? `${unknownStops} 个站点没有可用营业事实` : '',
      arrivalUnknownStops ? `${arrivalUnknownStops} 个站点计划到达时间未知` : '',
      lastEntryUnknownStops ? `${lastEntryUnknownStops} 个站点最晚入场未知` : ''
    ].filter(Boolean);
    if (!timingUnknownStops && gaps.length) {
      return {
        id: 'edit-hours',
        label: '营业时间',
        state: '部分待复核',
        detail: `已核对 ${checkedStops} 个站点未发现闭馆或时段冲突；${gaps.join('，')}，需出发前确认。`
      };
    }
    return {
      id: 'edit-hours',
      label: '营业时间',
      state: '部分待复核',
      detail: `已核对 ${checkedStops} 个站点未发现出行日闭馆冲突，但到达时段/最晚入场未知，另有 ${unknownStops} 个站点需复核。`
    };
  }
  return {
    id: 'edit-hours',
    label: '营业时间',
    state: '通过',
    detail: `已核对 ${checkedStops} 个站点的出行日营业时间及到达时段。`
  };
}

export function parseBudgetConstraint(value) {
  const parsed = parseMoneyRange(value);
  const text = String(value ?? '').replace(/\s+/g, '');
  const perPerson = /人均|每人|每位|\/人|perperson/i.test(text);
  const daily = /每日|每天|日均|\/天|perday/i.test(text);
  const fullTrip = /全程|全段|总预算|总计|合计|一共|整趟|整个行程|整段|trip/i.test(text);
  const scope = daily && !fullTrip ? 'daily' : 'trip';
  return {
    ...parsed,
    scope,
    perPerson,
    explicitScope: daily || fullTrip,
    semanticsLabel: `${scope === 'daily' ? '每日' : '全程'}${perPerson ? '人均' : ''}`
  };
}

function budgetThresholdFromConstraints(constraints, stops) {
  const parsed = parseBudgetConstraint(constraints?.budget);
  const dayCount = Math.max(1, new Set(stops.map((stop) => stop.day || 'Day 1')).size);
  const multiplier = parsed.scope === 'daily' ? dayCount : 1;
  if (!parsed.known) {
    return {
      ...parsed,
      dayCount,
      threshold: 0,
      thresholdMin: null,
      thresholdMax: null,
      perPerson: parsed.perPerson ? parsed.estimate : 0
    };
  }
  return {
    ...parsed,
    dayCount,
    threshold: parsed.estimate * multiplier,
    thresholdMin: parsed.min * multiplier,
    thresholdMax: parsed.max * multiplier,
    perPerson: parsed.perPerson ? parsed.estimate : 0
  };
}

function formatMoneyAmount(value) {
  if (value == null || !Number.isFinite(Number(value))) return '';
  const amount = Number(value);
  return Number.isInteger(amount) ? amount.toLocaleString('zh-CN') : amount.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

function formatBudgetSummary(summary) {
  if (!summary?.knownCount) return summary?.unknownCount ? `待补充（${summary.unknownCount} 处费用未知）` : '待核对';
  const amount =
    summary.min === summary.max ? `约 ${formatMoneyAmount(summary.min)} 元` : `约 ${formatMoneyAmount(summary.min)}–${formatMoneyAmount(summary.max)} 元`;
  return summary.unknownCount ? `${amount}（另有 ${summary.unknownCount} 处待补充）` : amount;
}

function splitConstraintTerms(value) {
  return [
    ...new Set(
      String(value ?? '')
        .replace(/(?:必须|必去|想去|希望去|避开|不要去|不想去)/g, '')
        .split(/[、,，；;|\n]+/)
        .map((item) => truncateString(item.trim(), 40))
        .filter((item) => item.length >= 2)
    )
  ].slice(0, 12);
}

// Words that name a kind of place or activity rather than a place. They cannot
// be checked against stop names, so the validation says so instead of
// reporting them as satisfied.
const CATEGORY_TERM =
  /^(?:网红(?:店|景点|打卡点)?|购物|商场|商业街|景区|寺庙|博物馆|美术馆|展览|爬山|登山|徒步|排队|人多|夜店|酒吧|夜市|小吃街|古镇|游乐园|主题乐园|动物园|海边|室内|室外|收费景点|门票贵的|太远的|远的)$/;

function placeVariantsForStop(stop, city) {
  const trusted = findTrustedPoi(stop, city);
  return { trusted, variants: placeNameVariants(stop?.name, trusted ? [trusted.name, ...(trusted.aliases ?? [])] : []) };
}

/**
 * Alias-aware, normalized match between a constraint term and a stop:
 * equal catalog POI, or one name variant containing the other (so "柳浪闻莺公园"
 * matches the stop "柳浪闻莺" and "龙井茶园" matches the term "龙井茶园").
 */
export function stopMatchesTerm(stop, term, city = '') {
  const termKey = normalizePlaceText(term);
  if (termKey.length < 2) return false;
  const { trusted, variants } = placeVariantsForStop(stop, city);
  const termTrusted = findTrustedPoi({ name: term }, city);
  if (trusted && termTrusted && trusted.poiId === termTrusted.poiId) return true;
  const termVariants = placeNameVariants(term, termTrusted ? [termTrusted.name, ...(termTrusted.aliases ?? [])] : []);
  return variants.some((variant) => termVariants.some((candidate) => variant.includes(candidate) || (variant.length >= 2 && candidate.includes(variant))));
}

export function isCategoryConstraintTerm(term) {
  return CATEGORY_TERM.test(String(term ?? '').trim());
}

export function buildConstraintValidation(stops, constraints = {}, city = '') {
  const mustGo = splitConstraintTerms(constraints?.mustGo);
  const avoidTerms = splitConstraintTerms(constraints?.avoid);
  const avoidCategories = avoidTerms.filter(isCategoryConstraintTerm);
  const avoid = avoidTerms.filter((term) => !isCategoryConstraintTerm(term));
  const mustGoCategories = mustGo.filter(isCategoryConstraintTerm);
  const mustGoPlaces = mustGo.filter((term) => !isCategoryConstraintTerm(term));
  if (!mustGo.length && !avoidTerms.length) {
    return { id: 'edit-constraints', label: '必去与避开', state: '未设置', detail: '可填写必去地点和想避开的内容，生成后会在这里显示是否满足。' };
  }
  const missingMustGo = mustGoPlaces.filter((term) => !stops.some((stop) => stopMatchesTerm(stop, term, city)));
  const includedAvoid = avoid.filter((term) => stops.some((stop) => stopMatchesTerm(stop, term, city)));
  const categories = [...mustGoCategories, ...avoidCategories];
  const detail = [
    mustGoPlaces.length
      ? missingMustGo.length
        ? `必去未找到：${missingMustGo.join('、')}。`
        : `已按名称（含别名）找到 ${mustGoPlaces.length} 个必去地点。`
      : '',
    avoid.length ? (includedAvoid.length ? `路线仍包含想避开：${includedAvoid.join('、')}。` : `站点名称（含别名）中没有 ${avoid.length} 个避开项。`) : '',
    categories.length ? `“${categories.join('、')}”是类别词，系统无法按名称核对，请自己看一遍站点。` : '',
    missingMustGo.length || includedAvoid.length ? '请编辑站点或调整约束后再出发。' : ''
  ]
    .filter(Boolean)
    .join(' ');
  const state = missingMustGo.length || includedAvoid.length ? '未完全满足' : categories.length ? '需人工确认' : '已纳入';
  return { id: 'edit-constraints', label: '必去与避开', state, detail };
}

function buildBudgetValidation(budgetSummary, constraints, stops) {
  const parsed = parseBudgetConstraint(constraints?.budget);
  if (!parsed.raw) {
    return {
      id: 'edit-budget',
      label: '预算风险',
      state: '无预算约束',
      detail: `按站点费用${formatBudgetSummary(budgetSummary)}，填写全程、每日或人均预算后可判断是否超支。`
    };
  }
  if (!parsed.known) {
    return { id: 'edit-budget', label: '预算风险', state: '待补充', detail: '预算金额无法识别，请填写数字并注明全程或每日（需要时注明人均）。' };
  }
  const { threshold, thresholdMin, thresholdMax, dayCount, semanticsLabel } = budgetThresholdFromConstraints(constraints, stops);
  if (!budgetSummary?.knownCount) {
    return {
      id: 'edit-budget',
      label: '预算风险',
      state: '待补充',
      detail: `${semanticsLabel}预算约 ${formatMoneyAmount(parsed.min)}${parsed.isRange ? `–${formatMoneyAmount(parsed.max)}` : ''} 元（${parsed.scope === 'daily' ? `每天，共 ${dayCount} 天` : '全程'}），站点费用均未知，不能判断是否超支。`
    };
  }
  const definitelyOver = budgetSummary.min > thresholdMax;
  const definitelyWithin = budgetSummary.max <= thresholdMin;
  let state = definitelyOver ? '超预算' : definitelyWithin ? '可控' : '区间待复核';
  if (budgetSummary.unknownCount && !definitelyOver) state = '部分待复核';
  const routeText = formatBudgetSummary(budgetSummary);
  const thresholdText =
    thresholdMin === thresholdMax ? `约 ${formatMoneyAmount(threshold)} 元` : `${formatMoneyAmount(thresholdMin)}–${formatMoneyAmount(thresholdMax)} 元`;
  // Daily budgets: state the per-day amount the user picked, then the full-trip total it was
  // multiplied into ("每日人均预算 300 元 × 2 天 = 全程约 600 元"), never "每日 600".
  const budgetText =
    parsed.scope === 'daily'
      ? `${semanticsLabel}预算 ${formatMoneyAmount(parsed.min)}${parsed.isRange ? `–${formatMoneyAmount(parsed.max)}` : ''} 元 × ${dayCount} 天 = 全程${thresholdText}`
      : `${semanticsLabel}预算 ${thresholdText}（全程）`;
  const detail = `${budgetText}，站点费用${routeText}。${definitelyOver ? '按已知最低费用也已超预算，建议替换高价站点。' : definitelyWithin ? '已知费用在预算范围内，实际价格仍需出发前复核。' : '费用区间与预算重叠，需核对价格或补充缺失费用。'}`;
  return { id: 'edit-budget', label: '预算风险', state, detail };
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
  const lowConfidence = stops.filter((stop) => coordinateVerificationLevel(stop) !== 'verified').length;
  const budget = sumStopCosts(stops);
  const execution = summarizeRouteExecution(stops, context.routeLegs);
  const calculated = [
    ...routeExecutionValidationRows(execution, { reason, crowdedDay, missingCoordinate }),
    buildBudgetValidation(budget, context.constraints, stops),
    buildOpeningHoursValidation(stops, context.city, context.travelDate),
    buildConstraintValidation(stops, context.constraints, context.city),
    {
      id: 'edit-geo',
      label: '定位可信',
      state: lowConfidence ? '需复核' : '通过',
      detail: lowConfidence
        ? `${lowConfidence} 个站点的坐标没有经过已审核 POI 或地图服务精确定位，出发前请核对位置。`
        : '全部站点坐标来自已核对地点或地图服务精确定位。'
    }
  ];
  // Only server-computed rows survive; model-written rows (e.g. "拥挤风险：通过") are dropped.
  const merged = [...calculated, ...systemValidations(validations).filter((item) => !calculated.some((next) => next.id === item.id))];
  return merged.slice(0, 8);
}

function normalizeRoutebookStop(stop, index, city, context = {}) {
  const coordinate = normalizeCoordinate(stop, city, index);
  const name = truncateString(stop?.name, 48) || `站点 ${index + 1}`;
  const costText = truncateString(stop?.cost, 32);
  const costInfo = stopCostInfo({ ...stop, cost: costText });
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
    cost: costText || (costInfo.known ? formatCostInfo(costInfo) : '待估算'),
    costInfo: { ...costInfo, text: costText || (costInfo.known ? formatCostInfo(costInfo) : '待估算') },
    verify: truncateString(stop?.verify, 120) || '需要真实打卡继续核对',
    risk: truncateString(stop?.risk, 120) || '需出发前复核',
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
    transportMode: normalizeStopTransportMode(stop?.transportMode),
    sourceEvidence: normalizeStopEvidence(stop?.sourceEvidence),
    facts: normalizeStopFacts(stop?.facts),
    provenance: normalizeStopProvenance(stop, name, { city, importedSources: context.importedSources })
  };
}

export function normalizeStopEvidence(items = []) {
  if (!Array.isArray(items)) return [];
  return items
    .slice(0, 5)
    .map((item, index) => ({
      id: sanitizePublicId(item?.id) || `evidence-${index + 1}`,
      sourceId: sanitizePublicId(item?.sourceId),
      authorizationStatus: truncateString(item?.authorizationStatus, 40),
      authorizationScope: truncateString(item?.authorizationScope, 80),
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
    routeLegs: routebook?.routeLegs,
    travelDate: resolveTravelDate(routebook?.travelDate, routebook?.constraints?.date, routebook?.provider?.travelDate)
  };
}

export function normalizeRouteVariant(variant, index, city, fallbackStops = [], context = {}) {
  const mode = truncateString(variant?.mode, 24) || '自定义';
  const sourceStops = Array.isArray(variant?.stops) && variant.stops.length ? variant.stops : fallbackStops;
  const stops = sourceStops
    .slice(0, MAX_ROUTEBOOK_STOPS)
    .map((stop, stopIndex) => normalizeRoutebookStop(stop, stopIndex, city, { importedSources: context?.importedSources }));
  if (stops.length < 2) return null;
  const id = sanitizePublicId(variant?.id) || cryptoRandomId();
  const days = [...new Set(stops.map((stop) => stop.day || 'Day 1'))];
  const routeLegs = normalizeStoredRouteLegs(variant?.routeLegs, stops, context?.constraints?.transport);
  return {
    id,
    mode,
    label: truncateString(variant?.label, 40) || `${mode}版`,
    summary: truncateString(variant?.summary, 160) || `按${mode}偏好重排，并保留原路书的可信校验。`,
    days,
    stops,
    routeLegs,
    trustScore: calculateRouteTrustScore(stops),
    metrics: buildRoutebookMetrics(stops, variant?.metrics, routeLegs),
    validations: buildRoutebookValidations(stops, variant?.validations, `${mode}变体`, { city, ...(context ?? {}), routeLegs }),
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
  const importedSources = normalizeImportedSources(input?.importedSources).slice(0, MAX_IMPORT_URLS);
  const stops = (Array.isArray(input?.stops) ? input.stops : [])
    .slice(0, MAX_ROUTEBOOK_STOPS)
    .map((stop, index) => normalizeRoutebookStop(stop, index, city, { importedSources }));
  if (stops.length < 2) {
    throw createHttpError('路书至少需要 2 个站点才能保存', 400, 'ROUTEBOOK_TOO_SHORT');
  }
  const id = sanitizePublicId(existingId || input?.id || input?.publicId) || cryptoRandomId();
  // 保存时只保留有站点的天（旧数据里可能有「第 N 天 0 站」），顺序以 input.days 为准。
  const stopDays = [...new Set(stops.map((stop) => stop.day || 'Day 1'))];
  const inputDays =
    Array.isArray(input?.days) && input.days.length
      ? input.days
          .map((day) => truncateString(day, 24))
          .filter((day) => day && stopDays.includes(day))
          .slice(0, 10)
      : [];
  const days = [...inputDays, ...stopDays.filter((day) => !inputDays.includes(day))];
  const sourceSummary = normalizeSourceSummary(input?.sourceSummary, input?.importedSources);
  const routeLegs = normalizeStoredRouteLegs(input?.routeLegs, stops, input?.constraints?.transport);
  const validationContext = {
    city,
    constraints: input?.constraints,
    routeLegs,
    travelDate: resolveTravelDate(input?.travelDate, input?.constraints?.date, input?.provider?.travelDate)
  };
  const validations = mergeSourceValidations(
    buildRoutebookValidations(stops, input?.validations, input?.editReason || '保存', validationContext),
    sourceSummary
  );
  const metrics = mergeSourceMetrics(buildRoutebookMetrics(stops, input?.metrics, routeLegs), sourceSummary);
  const trustScore = calculateRouteTrustScore(stops);
  const publishStatus = ROUTEBOOK_STATUSES.has(input?.publishStatus) ? input.publishStatus : 'draft';
  const versionMetadata = routebookVersionMetadata(input, now, publishStatus);
  return {
    id,
    publicId: id,
    profileId: normalizeProfileId(input?.profileId),
    editToken: sanitizeEditToken(input?.editToken),
    editTokenHash: sanitizeEditToken(input?.editToken)
      ? hashSecretToken(sanitizeEditToken(input.editToken))
      : /^[a-f0-9]{18}$/.test(String(input?.editTokenHash ?? ''))
        ? input.editTokenHash
        : '',
    creator: normalizeCreator(input?.creator),
    publishStatus,
    sourceAuthorization: truncateString(input?.sourceAuthorization || input?.creator?.sourceAuthorization, 40) || 'self-owned',
    copyCount: clampNumber(input?.copyCount, 0, 1000000, 0),
    city,
    // V-U27: kept only while it still differs from the chosen city (accepting it clears it).
    ...(suggestedCityFor(city, input?.suggestedCity) ? { suggestedCity: suggestedCityFor(city, input?.suggestedCity) } : {}),
    title: truncateString(input?.title, 80) || `${city} 可信路书`,
    summary: truncateString(input?.summary, 220) || '已保存为可分享、可编辑的可信路书。',
    trustScore,
    days,
    stops,
    routeLegs,
    assets: Array.isArray(input?.assets)
      ? input.assets.slice(0, 12).map((item, index) => ({
          label: truncateString(item?.label, 30) || `资产 ${index + 1}`,
          type: truncateString(item?.type, 24) || 'POI',
          confidence: clampNumber(item?.confidence, 0, 99, 72)
        }))
      : [],
    validations,
    metrics,
    // Process logs are only kept when the server wrote them (logsSource 'server');
    // model-written "logs" from older routebooks are dropped on the next save.
    ...normalizeProcessLogs(input),
    aiNotes: normalizeAiNotes(input?.aiNotes),
    importedSources,
    sourceSummary,
    constraints: normalizeRouteConstraints(input?.constraints),
    travelDate: resolveTravelDate(input?.travelDate, input?.constraints?.date, input?.provider?.travelDate),
    variants: normalizeRouteVariants(input?.variants, city, stops, { ...validationContext, importedSources }),
    activeVariantId: sanitizePublicId(input?.activeVariantId),
    provider: normalizeStoredProvider(input?.provider, {
      travelDate: resolveTravelDate(input?.travelDate, input?.constraints?.date, input?.provider?.travelDate),
      savedAt: now.toISOString()
    }),
    routingWarning: normalizeRoutingWarning(input?.routingWarning, publishStatus),
    guideOrigins: routebookGuideOrigins({ guideOrigins: input?.guideOrigins, importedSources }),
    friendLink: normalizeFriendLink(input?.friendLink),
    authorshipClaim: normalizeAuthorshipClaim(input?.authorshipClaim),
    ...versionMetadata
  };
}

/**
 * Unlisted "friend link" access key. Server-generated only (never accepted from a
 * client save) and never part of public views.
 * @param {any} link
 */
export function normalizeFriendLink(link) {
  if (!link || typeof link !== 'object' || !/^[a-f0-9]{32}$/.test(String(link.key ?? ''))) return null;
  return { key: String(link.key), createdAt: truncateString(link.createdAt, 60) };
}

/** @param {any} claim */
function normalizeAuthorshipClaim(claim) {
  if (!claim || typeof claim !== 'object' || claim.claimed !== true) return null;
  return { claimed: true, claimedAt: truncateString(claim.claimedAt, 60), note: truncateString(claim.note, 200) };
}

/**
 * A published routebook whose re-check found unverified legs keeps its status and
 * carries this warning instead (shown to the author and ops). Only meaningful
 * while the routebook is public; dropped otherwise.
 * @param {any} warning
 * @param {string} publishStatus
 */
export function normalizeRoutingWarning(warning, publishStatus) {
  if (!warning || typeof warning !== 'object' || !PUBLIC_ROUTE_STATUSES.has(publishStatus)) return null;
  const expectedLegs = clampNumber(warning.expectedLegs, 0, 1000, 0);
  const unverifiedLegs = clampNumber(warning.unverifiedLegs, 0, expectedLegs, 0);
  if (!unverifiedLegs) return null;
  return {
    code: 'ROUTING_UNVERIFIED_AFTER_PUBLISH',
    unverifiedLegs,
    expectedLegs,
    detectedAt: truncateString(warning.detectedAt, 60),
    message: `重新核验发现 ${unverifiedLegs}/${expectedLegs} 段道路暂未核验，路书保持公开，相关路段不显示精确道路耗时。`
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
    mode: source.mode === 'fast' || source.mode === 'deep' ? source.mode : '',
    // Set when the chosen mode's model failed upstream and the fallback model wrote this routebook.
    fellBackFrom: source.fellBackFrom === 'fast' || source.fellBackFrom === 'deep' ? source.fellBackFrom : '',
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

// 精选路线的道路结果：配了高德路线 key 时，按需查一次并缓存 12 小时；没配就保持「还没查」，不伪造。
const CURATED_LEGS_TTL_MS = 12 * 60 * 60 * 1000;
const curatedLegsCache = new Map();
async function withCuratedRouteLegs(routebook) {
  if (!routebook) return routebook;
  const { AMAP_ROUTING_KEY } = await import('../config/index.mjs');
  if (!AMAP_ROUTING_KEY) return routebook;
  const hit = curatedLegsCache.get(routebook.publicId);
  if (hit && Date.now() - hit.at < CURATED_LEGS_TTL_MS) return hit.routebook;
  try {
    const { attachServerRouteLegs } = await import('../routing/service.mjs');
    const routed = await attachServerRouteLegs(routebook, AbortSignal.timeout(15000));
    curatedLegsCache.set(routebook.publicId, { at: Date.now(), routebook: routed });
    return routed;
  } catch {
    return routebook;
  }
}

export async function getResolvableRoutebook(publicId) {
  const saved = await getSavedRoutebook(publicId);
  if (saved?.tombstone || saved?.deletedAt) return null;
  return saved ?? withCuratedRouteLegs(getCuratedRoutebook(publicId));
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
        sourceId: importSourceId(source),
        url: safeSourceUrl(source?.url),
        finalUrl: safeSourceUrl(source?.finalUrl),
        platform: truncateString(source?.platform, 40),
        platformId: truncateString(source?.platformId, 40),
        status: truncateString(source?.status, 30),
        ...(['too-little', 'deleted-or-login'].includes(source?.unavailableReason) ? { unavailableReason: source.unavailableReason } : {}),
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

const PROCESS_LOG_STATUSES = new Set(['完成', '跳过', '未执行', '需复核', '失败']);

/**
 * Server-written process log (stage events recorded by code during generation,
 * geocoding and routing). Older routebooks carried model-written "logs" that
 * claimed checks the system never ran; those are not kept.
 * @param {any} input
 */
export function normalizeProcessLogs(input) {
  if (input?.logsSource !== 'server' || !Array.isArray(input?.logs)) return { logs: [], logsSource: 'server' };
  const logs = sanitizeProcessLogs(input.logs);
  // Logs are signed when the server writes them; a client cannot inject "checks" on save.
  if (!safeEqualHex(String(input?.logsProof ?? ''), signProcessLogs(logs))) return { logs: [], logsSource: 'server' };
  return { logs, logsSource: 'server', logsProof: signProcessLogs(logs) };
}

function sanitizeProcessLogs(logs) {
  return logs.slice(0, 12).map((log, index) => ({
    stage: truncateString(log?.stage, 18) || `阶段 ${index + 1}`,
    input: truncateString(log?.input, 32),
    result: truncateString(log?.result, 72),
    status: PROCESS_LOG_STATUSES.has(log?.status) ? log.status : '完成',
    time: truncateString(log?.time, 40)
  }));
}

export function signProcessLogs(logs) {
  return createHmac('sha256', PROFILE_ID_SECRET)
    .update(`process-logs|${JSON.stringify(logs)}`)
    .digest('hex');
}

/** Builds a signed, server-written process log. */
export function serverProcessLogs(entries) {
  const logs = sanitizeProcessLogs(entries);
  return { logs, logsSource: 'server', logsProof: signProcessLogs(logs) };
}

/** Logs safe to display: server-written only (older model-written logs are hidden). */
export function displayableProcessLogs(routebook) {
  return routebook?.logsSource === 'server' && Array.isArray(routebook?.logs) ? routebook.logs : [];
}

/**
 * Model-written risk hints. Always shown as "AI 提示（未核验）" and never with a
 * pass/fail state, so they cannot read as system checks.
 * @param {any} notes
 */
export function normalizeAiNotes(notes) {
  if (!Array.isArray(notes)) return [];
  return notes
    .slice(0, 6)
    .map((note) => ({ label: truncateString(note?.label, 18), detail: truncateString(note?.detail, 100) }))
    .filter((note) => note.label && note.detail);
}

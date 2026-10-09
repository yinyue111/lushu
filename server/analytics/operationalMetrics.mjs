import { buildAiObservabilitySummary } from './aiObservability.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_REPORTING_WINDOW_DAYS = 30;
export const SEVEN_DAY_RETURN_WINDOW_DAYS = 7;

const GENERATION_KIND = 'generate-routebook';
const GENERATION_SUCCESS_STATUS = 'ok';
const SATISFACTION_SURFACES = new Map([
  ['ai-satisfaction-positive', 'positive'],
  ['ai-satisfaction-negative', 'negative']
]);
const UNUSABLE_COMPLAINT_SURFACE = 'route-unusable-complaint';

/**
 * Calculate the operational metrics consumed by /api/dashboard.
 *
 * All inputs are treated as immutable. Rows with an invalid timestamp or a
 * timestamp after asOf are ignored. Profile/route rate metrics only use rows
 * that have both a non-anonymous profileId and a route identifier.
 * @param {{ aiLogs?: any[], exposures?: any[], activityRows?: any[], asOf?: string | number | Date, reportingWindowDays?: number }} [options]
 */
export function calculateOperationalMetrics({
  aiLogs = [],
  exposures = [],
  activityRows = [],
  asOf,
  reportingWindowDays = DEFAULT_REPORTING_WINDOW_DAYS
} = {}) {
  const asOfMs = parseAsOf(asOf);
  const safeReportingWindowDays = positiveInteger(reportingWindowDays, 'reportingWindowDays');
  const reportingWindowMs = safeReportingWindowDays * DAY_MS;
  const returnWindowMs = SEVEN_DAY_RETURN_WINDOW_DAYS * DAY_MS;
  const reportingStartMs = asOfMs - reportingWindowMs;
  const retentionCohortStartMs = reportingStartMs - returnWindowMs;
  const retentionCohortEndMs = asOfMs - returnWindowMs;
  const aiObservability = buildAiObservabilitySummary(aiLogs, {
    asOf: asOfMs,
    windowDays: safeReportingWindowDays
  });

  const successfulGenerations = dedupeSuccessfulGenerations(aiLogs, asOfMs);
  const reportingGenerations = successfulGenerations.filter((row) => inClosedWindow(row.timestampMs, reportingStartMs, asOfMs));
  const reportingJourneys = new Map(reportingGenerations.filter((row) => row.journeyKey).map((row) => [row.journeyKey, row]));

  // Keep the existing dashboard field and successful-generation semantics,
  // while sharing requestId deduplication/window/percentile logic with /api/logs.
  const generationLatencyMs = aiObservability.successfulDurationMs;

  const routesByProfile = new Map();
  for (const generation of reportingJourneys.values()) {
    const routes = routesByProfile.get(generation.profileId) ?? new Set();
    routes.add(generation.routeId);
    routesByProfile.set(generation.profileId, routes);
  }
  const generatorProfiles = routesByProfile.size;
  const repeatGeneratorProfiles = [...routesByProfile.values()].filter((routeIds) => routeIds.size >= 2).length;

  const latestSatisfactionByJourney = new Map();
  const unusableComplaintJourneys = new Set();
  for (const exposure of Array.isArray(exposures) ? exposures : []) {
    const timestampMs = rowTimestampMs(exposure);
    if (!inClosedWindow(timestampMs, reportingStartMs, asOfMs)) continue;
    const journey = stableJourney(exposure);
    const generation = journey ? reportingJourneys.get(journey.key) : null;
    if (!generation || timestampMs < generation.timestampMs) continue;

    const surface = String(exposure?.surface ?? '')
      .trim()
      .toLowerCase();
    if (SATISFACTION_SURFACES.has(surface)) {
      const candidate = {
        timestampMs,
        eventId: stableEventId(exposure, surface),
        sentiment: SATISFACTION_SURFACES.get(surface)
      };
      const current = latestSatisfactionByJourney.get(journey.key);
      if (!current || compareEvents(candidate, current) > 0) {
        latestSatisfactionByJourney.set(journey.key, candidate);
      }
    }
    if (surface === UNUSABLE_COMPLAINT_SURFACE) {
      unusableComplaintJourneys.add(journey.key);
    }
  }
  const aiFeedbackJourneys = latestSatisfactionByJourney.size;
  const aiSatisfiedJourneys = [...latestSatisfactionByJourney.values()].filter((feedback) => feedback.sentiment === 'positive').length;
  const unusableComplaintEligibleJourneys = reportingJourneys.size;

  const firstGenerationByProfile = new Map();
  for (const generation of successfulGenerations) {
    if (!generation.profileId || !generation.journeyKey) continue;
    const current = firstGenerationByProfile.get(generation.profileId);
    if (!current || compareGenerations(generation, current) < 0) {
      firstGenerationByProfile.set(generation.profileId, generation);
    }
  }
  const eligibleSevenDayCohort = new Map(
    [...firstGenerationByProfile.entries()].filter(([, generation]) => inClosedWindow(generation.timestampMs, retentionCohortStartMs, retentionCohortEndMs))
  );
  const returnedProfiles = new Set();
  const rawAiLogs = Array.isArray(aiLogs) ? aiLogs : [];
  const nonSuccessfulGenerationActivities = rawAiLogs.filter((row) => row?.kind !== GENERATION_KIND || row?.status !== GENERATION_SUCCESS_STATUS);
  const activities = [
    ...successfulGenerations.map((generation) => generation.source),
    ...nonSuccessfulGenerationActivities,
    ...(Array.isArray(exposures) ? exposures : []),
    ...(Array.isArray(activityRows) ? activityRows : [])
  ];
  for (const activity of activities) {
    const profileId = stableProfileId(activity?.profileId);
    const firstGeneration = profileId ? eligibleSevenDayCohort.get(profileId) : null;
    if (!firstGeneration || returnedProfiles.has(profileId)) continue;
    const timestampMs = rowTimestampMs(activity);
    if (!Number.isFinite(timestampMs)) continue;
    const returnStartMs = firstGeneration.timestampMs + DAY_MS;
    const returnEndMs = firstGeneration.timestampMs + returnWindowMs;
    if (inClosedWindow(timestampMs, returnStartMs, returnEndMs)) {
      returnedProfiles.add(profileId);
    }
  }
  const eligibleSevenDayProfiles = eligibleSevenDayCohort.size;
  const sevenDayReturnedProfiles = returnedProfiles.size;

  const funnel = {
    generationLatencyMs,
    aiObservability,
    sevenDayReturnRate: percentOrNull(sevenDayReturnedProfiles, eligibleSevenDayProfiles),
    sevenDayReturnedProfiles,
    eligibleSevenDayProfiles,
    sevenDayReturnRateStatus: rateStatus(eligibleSevenDayProfiles),
    repeatGenerationRate: percentOrNull(repeatGeneratorProfiles, generatorProfiles),
    repeatGeneratorProfiles,
    generatorProfiles,
    repeatGenerationRateStatus: rateStatus(generatorProfiles),
    aiSatisfactionRate: percentOrNull(aiSatisfiedJourneys, aiFeedbackJourneys),
    aiSatisfiedJourneys,
    aiFeedbackJourneys,
    aiSatisfactionRateStatus: rateStatus(aiFeedbackJourneys),
    unusableComplaintRate: percentOrNull(unusableComplaintJourneys.size, unusableComplaintEligibleJourneys),
    unusableComplaintJourneys: unusableComplaintJourneys.size,
    unusableComplaintEligibleJourneys,
    unusableComplaintRateStatus: rateStatus(unusableComplaintEligibleJourneys)
  };

  return {
    funnel,
    metricDefinitions: {
      ...buildMetricDefinitions({
        asOfMs,
        reportingStartMs,
        retentionCohortStartMs,
        retentionCohortEndMs,
        reportingWindowDays: safeReportingWindowDays,
        statuses: {
          generationLatencyMs: generationLatencyMs.status,
          sevenDayReturnRate: funnel.sevenDayReturnRateStatus,
          repeatGenerationRate: funnel.repeatGenerationRateStatus,
          aiSatisfactionRate: funnel.aiSatisfactionRateStatus,
          unusableComplaintRate: funnel.unusableComplaintRateStatus
        }
      }),
      aiObservability: {
        metric: 'aiObservability',
        status: aiObservability.totalCount ? 'available' : 'no-samples',
        window: aiObservability.window,
        dedupe: aiObservability.deduplication.rule,
        timeoutRate: '窗口内 timedOut=true、阶段 timedOut=true 或明确 timeout 错误的去重生成请求 / 去重生成请求',
        tokenCoverage: '至少一个上游尝试返回有效 usage 的去重生成请求 / 去重生成请求',
        costCoverage: '具备完整 token usage 与有效环境价格快照的去重生成请求 / 去重生成请求'
      }
    }
  };
}

function dedupeSuccessfulGenerations(rows, asOfMs) {
  const byGeneration = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.kind !== GENERATION_KIND || row?.status !== GENERATION_SUCCESS_STATUS) continue;
    const timestampMs = rowTimestampMs(row);
    if (!Number.isFinite(timestampMs) || timestampMs > asOfMs) continue;
    const journey = stableJourney(row);
    const requestId = stableIdentifier(row?.requestId);
    const routeId = stableRouteId(row);
    const dedupeKey = journey?.key || (routeId ? `route:${routeId}` : '') || (requestId ? `request:${requestId}` : '');
    if (!dedupeKey) continue;
    const candidate = {
      source: row,
      timestampMs,
      durationMs: finiteNonNegative(row?.durationMs),
      profileId: journey?.profileId ?? '',
      routeId: journey?.routeId ?? routeId,
      journeyKey: journey?.key ?? '',
      tieBreaker: `${requestId}\u0000${stableEventId(row, GENERATION_KIND)}`
    };
    const current = byGeneration.get(dedupeKey);
    if (!current || compareGenerations(candidate, current) < 0) {
      byGeneration.set(dedupeKey, candidate);
    }
  }
  return [...byGeneration.values()].sort(compareGenerations);
}

function stableJourney(row) {
  const profileId = stableProfileId(row?.profileId);
  const routeId = stableRouteId(row);
  if (!profileId || !routeId) return null;
  return { profileId, routeId, key: `${profileId}::${routeId}` };
}

function stableProfileId(value) {
  const id = stableIdentifier(value);
  return !id || id.toLowerCase() === 'anonymous' ? '' : id;
}

function stableRouteId(row) {
  const id = stableIdentifier(row?.publicId || row?.routeId || row?.itemId);
  return !id || ['anonymous', 'unknown'].includes(id.toLowerCase()) ? '' : id;
}

function stableIdentifier(value) {
  return String(value ?? '')
    .trim()
    .slice(0, 160);
}

function stableEventId(row, fallback) {
  return stableIdentifier(row?.id || row?.requestId || `${fallback}:${row?.createdAt ?? ''}`);
}

function rowTimestampMs(row) {
  const timestamp = Date.parse(String(row?.createdAt ?? row?.occurredAt ?? row?.timestamp ?? ''));
  return Number.isFinite(timestamp) ? timestamp : Number.NaN;
}

function finiteNonNegative(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function compareGenerations(left, right) {
  return left.timestampMs - right.timestampMs || compareText(left.tieBreaker, right.tieBreaker);
}

function compareEvents(left, right) {
  return left.timestampMs - right.timestampMs || compareText(left.eventId, right.eventId);
}

function compareText(left, right) {
  const leftText = String(left);
  const rightText = String(right);
  return leftText === rightText ? 0 : leftText < rightText ? -1 : 1;
}

function inClosedWindow(timestampMs, startMs, endMs) {
  return Number.isFinite(timestampMs) && timestampMs >= startMs && timestampMs <= endMs;
}

function percentOrNull(numerator, denominator) {
  return denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : null;
}

function rateStatus(denominator) {
  return denominator > 0 ? 'available' : 'zero-denominator';
}

function parseAsOf(value) {
  const timestamp = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(String(value));
  if (!Number.isFinite(timestamp)) throw new TypeError('asOf must be a valid date or epoch timestamp');
  return timestamp;
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new TypeError(`${name} must be a positive integer`);
  return number;
}

function buildMetricDefinitions({ asOfMs, reportingStartMs, retentionCohortStartMs, retentionCohortEndMs, reportingWindowDays, statuses }) {
  const reportingWindow = {
    type: 'rolling',
    days: reportingWindowDays,
    startAt: new Date(reportingStartMs).toISOString(),
    endAt: new Date(asOfMs).toISOString(),
    bounds: 'inclusive'
  };
  const zeroDenominator = { value: null, status: 'zero-denominator' };
  return {
    generationLatency: {
      metric: 'generationLatencyMs',
      status: statuses.generationLatencyMs,
      window: reportingWindow,
      samples: '窗口内 status=ok 的 generate-routebook 事件，durationMs 必须为有限非负数',
      dedupe: '按 requestId 取最新且信息完整的记录；缺少 requestId 时仅合并完全相同的事件',
      percentileMethod: 'nearest-rank',
      emptySample: { p50: null, p90: null, p95: null, sampleCount: 0, status: 'no-samples' }
    },
    sevenDayReturn: {
      metric: 'sevenDayReturnRate',
      status: statuses.sevenDayReturnRate,
      cohortWindow: {
        startAt: new Date(retentionCohortStartMs).toISOString(),
        endAt: new Date(retentionCohortEndMs).toISOString(),
        bounds: 'inclusive',
        note: `保留完整 7 日观察期的最近 ${reportingWindowDays} 天首次生成 cohort`
      },
      returnWindow: {
        start: '首次成功生成后 24 小时（含）',
        end: '首次成功生成后 7 * 24 小时（含）'
      },
      numerator: '观察窗内至少发生一次后续生成、曝光或 activityRows 活动的稳定 profileId 数',
      denominator: '输入历史内首次成功生成落在成熟 cohort 窗口的稳定 profileId 数',
      dedupe: 'profileId',
      zeroDenominator
    },
    repeatGeneration: {
      metric: 'repeatGenerationRate',
      status: statuses.repeatGenerationRate,
      window: reportingWindow,
      numerator: '窗口内成功生成至少 2 个不同 routeId 的稳定 profileId 数',
      denominator: '窗口内至少成功生成 1 个 routeId 的稳定 profileId 数',
      dedupe: 'profileId + routeId',
      zeroDenominator
    },
    aiSatisfaction: {
      metric: 'aiSatisfactionRate',
      status: statuses.aiSatisfactionRate,
      window: reportingWindow,
      numerator: '窗口内生成路书收到的最新有效反馈为 ai-satisfaction-positive 的 profileId + routeId 数',
      denominator: '窗口内生成路书至少收到一次 positive 或 negative 满意度反馈的 profileId + routeId 数',
      dedupe: 'profileId + routeId；同一路书取时间最新反馈，同时间按事件 id 稳定决胜',
      zeroDenominator
    },
    unusableComplaint: {
      metric: 'unusableComplaintRate',
      status: statuses.unusableComplaintRate,
      window: reportingWindow,
      numerator: '窗口内生成后至少收到一次 route-unusable-complaint 的 profileId + routeId 数',
      denominator: '窗口内成功生成的稳定 profileId + routeId 数',
      dedupe: 'profileId + routeId；重复投诉只计 1 条路书',
      zeroDenominator
    }
  };
}

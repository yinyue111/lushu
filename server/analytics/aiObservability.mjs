export const DEFAULT_AI_OBSERVABILITY_WINDOW_DAYS = 30;
export const AI_COST_ESTIMATE_BASIS = 'environment-price-snapshot';
export const AI_GENERATION_STAGE_NAMES = Object.freeze(['model', 'geocoding', 'routing', 'persistence']);

const AI_GENERATION_STAGE_STATUSES = new Set(['completed', 'degraded', 'failed', 'skipped']);
const MODEL_USAGE_STATUSES = new Set(['reported', 'partial', 'unavailable']);
const COST_ESTIMATE_STATUSES = new Set(['estimated', 'unavailable']);
const GENERATION_KIND = 'generate-routebook';
const GENERATION_SUCCESS_STATUS = 'ok';
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Normalize usage returned by either Responses or Chat Completions.
 *
 * `dataOrUsage` may be a full provider response, an object containing `usage`,
 * or the usage object itself. Numeric strings are deliberately rejected: this
 * function is also used at the operations-view trust boundary.
 */
export function normalizeModelUsage(dataOrUsage, wireApi = '') {
  const source = objectOrNull(dataOrUsage);
  if (!source) return null;
  const usage = objectOrNull(source.usage) ?? objectOrNull(source.response?.usage) ?? source;
  const protocol = normalizeWireApi(wireApi || source.wireApi || source.api);
  const keys = selectUsageKeys(usage, protocol);
  if (!keys) return null;

  const inputTokens = nonNegativeSafeIntegerOrNull(usage[keys.input]);
  const outputTokens = nonNegativeSafeIntegerOrNull(usage[keys.output]);
  const reportedTotalTokens = nonNegativeSafeIntegerOrNull(usage[keys.total]);
  if (inputTokens == null && outputTokens == null && reportedTotalTokens == null) return null;

  const details = objectOrNull(usage.completion_tokens_details) ?? objectOrNull(usage.output_tokens_details);
  const reasoningTokens = details ? nonNegativeSafeIntegerOrNull(details.reasoning_tokens) : null;
  return {
    inputTokens,
    outputTokens,
    ...(reasoningTokens != null ? { reasoningTokens } : {}),
    totalTokens: reportedTotalTokens ?? (inputTokens != null && outputTokens != null ? safeIntegerSumOrNull(inputTokens, outputTokens) : null)
  };
}

/**
 * Summarize all upstream model attempts, including attempts without usage.
 * Missing usage is never estimated and therefore makes the result partial.
 */
export function summarizeModelUsage(attempts = []) {
  const rows = Array.isArray(attempts) ? attempts : [attempts];
  let reportedAttemptCount = 0;
  let allReportedAttemptsComplete = rows.length > 0;
  const inputTokens = nullableCounter();
  const outputTokens = nullableCounter();
  const totalTokens = nullableCounter();

  for (const attempt of rows) {
    const usage = normalizeAttemptUsage(attempt);
    if (!usage) {
      allReportedAttemptsComplete = false;
      continue;
    }
    reportedAttemptCount += 1;
    inputTokens.add(usage.inputTokens);
    outputTokens.add(usage.outputTokens);
    totalTokens.add(usage.totalTokens);
    if (usage.inputTokens == null || usage.outputTokens == null || usage.totalTokens == null) {
      allReportedAttemptsComplete = false;
    }
  }

  const attemptCount = rows.length;
  const aggregatedInputTokens = inputTokens.value();
  const aggregatedOutputTokens = outputTokens.value();
  const aggregatedTotalTokens = totalTokens.value();
  const status =
    reportedAttemptCount === 0
      ? 'unavailable'
      : reportedAttemptCount === attemptCount &&
          allReportedAttemptsComplete &&
          aggregatedInputTokens != null &&
          aggregatedOutputTokens != null &&
          aggregatedTotalTokens != null
        ? 'reported'
        : 'partial';
  return {
    inputTokens: aggregatedInputTokens,
    outputTokens: aggregatedOutputTokens,
    totalTokens: aggregatedTotalTokens,
    attemptCount,
    reportedAttemptCount,
    status
  };
}

/**
 * Strictly revalidate a stored modelUsage object and drop every extra field.
 */
export function normalizeStoredModelUsage(value) {
  const source = objectOrNull(value);
  if (!source) return null;
  const attemptCount = nonNegativeSafeIntegerOrNull(source.attemptCount);
  const reportedAttemptCount = nonNegativeSafeIntegerOrNull(source.reportedAttemptCount);
  if (attemptCount == null || reportedAttemptCount == null || reportedAttemptCount > attemptCount) return null;

  const inputTokens = nonNegativeSafeIntegerOrNull(source.inputTokens);
  const outputTokens = nonNegativeSafeIntegerOrNull(source.outputTokens);
  const totalTokens = nonNegativeSafeIntegerOrNull(source.totalTokens);
  const hasTokens = inputTokens != null || outputTokens != null || totalTokens != null;
  if ((reportedAttemptCount === 0 && hasTokens) || (reportedAttemptCount > 0 && !hasTokens)) return null;

  const derivedStatus =
    reportedAttemptCount === 0
      ? 'unavailable'
      : attemptCount > 0 && reportedAttemptCount === attemptCount && inputTokens != null && outputTokens != null && totalTokens != null
        ? 'reported'
        : 'partial';
  if (!MODEL_USAGE_STATUSES.has(source.status) || source.status !== derivedStatus) return null;

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    attemptCount,
    reportedAttemptCount,
    status: derivedStatus
  };
}

/**
 * Return a stable cost snapshot. The current provider model is recorded with
 * the configured price snapshot; incomplete usage/config stays unavailable.
 * @param {{ modelUsage?: any, model?: string, config?: Record<string, any>, processEnv?: Record<string, any> }} [options]
 */
export function estimateModelCost({ modelUsage, model, config, processEnv } = {}) {
  const pricing = readAiPricingConfig(config ?? processEnv ?? process.env);
  const actualModel = boundedString(model, 160) || null;
  const base = {
    status: 'unavailable',
    model: actualModel,
    currency: pricing.currency,
    amount: null,
    inputPricePerMillion: pricing.inputPricePerMillion,
    outputPricePerMillion: pricing.outputPricePerMillion,
    basis: AI_COST_ESTIMATE_BASIS
  };

  const usage = normalizeStoredModelUsage(modelUsage);
  const configurationComplete = Boolean(actualModel && pricing.currency && pricing.inputPricePerMillion != null && pricing.outputPricePerMillion != null);
  if (!configurationComplete || usage?.status !== 'reported') return base;

  const amount = (usage.inputTokens * pricing.inputPricePerMillion + usage.outputTokens * pricing.outputPricePerMillion) / 1_000_000;
  if (!Number.isFinite(amount) || amount < 0) return base;
  return {
    ...base,
    status: 'estimated',
    amount: roundNumber(amount, 12)
  };
}

/**
 * Parse only the supported environment-price snapshot fields.
 */
function readAiPricingConfig(environment = process.env) {
  const source = objectOrNull(environment) ?? {};
  const currencyInput = boundedString(source.AI_COST_CURRENCY, 3);
  return {
    currency: currencyInput && /^[A-Za-z]{3}$/.test(currencyInput) ? currencyInput.toUpperCase() : currencyInput ? null : 'USD',
    inputPricePerMillion: environmentNonNegativeNumberOrNull(source.AI_INPUT_COST_PER_MILLION_TOKENS),
    outputPricePerMillion: environmentNonNegativeNumberOrNull(source.AI_OUTPUT_COST_PER_MILLION_TOKENS),
    basis: AI_COST_ESTIMATE_BASIS
  };
}

/**
 * Strictly revalidate a stored cost estimate and return an allowlisted object.
 */
export function normalizeCostEstimate(value) {
  const source = objectOrNull(value);
  if (!source || !COST_ESTIMATE_STATUSES.has(source.status)) return null;
  const model = boundedString(source.model, 160) || null;
  const currency = typeof source.currency === 'string' && /^[A-Za-z]{3}$/.test(source.currency.trim()) ? source.currency.trim().toUpperCase() : null;
  const amount = finiteNonNegativeNumberOrNull(source.amount);
  const inputPricePerMillion = finiteNonNegativeNumberOrNull(source.inputPricePerMillion);
  const outputPricePerMillion = finiteNonNegativeNumberOrNull(source.outputPricePerMillion);
  if (source.basis !== AI_COST_ESTIMATE_BASIS) return null;

  if (source.status === 'estimated' && (!model || !currency || amount == null || inputPricePerMillion == null || outputPricePerMillion == null)) return null;
  if (source.status !== 'estimated' && source.amount != null) return null;

  return {
    status: source.status,
    model,
    currency,
    amount: source.status === 'estimated' ? amount : null,
    inputPricePerMillion,
    outputPricePerMillion,
    basis: AI_COST_ESTIMATE_BASIS
  };
}

/**
 * Normalize all four generation stages to a fixed, allowlisted shape.
 */
export function normalizeAiGenerationStages(value) {
  const source = objectOrNull(value) ?? {};
  return Object.fromEntries(
    AI_GENERATION_STAGE_NAMES.map((stageName) => {
      const raw = source[stageName];
      const stage = objectOrNull(raw);
      const durationMs = stage ? finiteNonNegativeNumberOrNull(stage.durationMs) : finiteNonNegativeNumberOrNull(raw);
      const timedOut = stage?.timedOut === true;
      const explicitStatus = typeof stage?.status === 'string' && AI_GENERATION_STAGE_STATUSES.has(stage.status) ? stage.status : '';
      const status =
        timedOut && ['completed', 'skipped'].includes(explicitStatus)
          ? 'degraded'
          : explicitStatus || (timedOut ? 'degraded' : durationMs != null ? 'completed' : 'skipped');
      return [stageName, { durationMs, status, timedOut }];
    })
  );
}

/**
 * Build the rolling AI-generation operations summary.
 *
 * De-duplication is deterministic: for a requestId, keep the latest valid
 * timestamp; equal timestamps prefer the more information-rich row; a stable
 * canonical JSON comparison breaks any remaining tie. Exact duplicates without
 * a requestId are collapsed by their canonical content.
 * @param {any[]} [logs]
 * @param {{ asOf?: string | number | Date, windowDays?: number }} [options]
 */
export function buildAiObservabilitySummary(logs = [], { asOf = Date.now(), windowDays = DEFAULT_AI_OBSERVABILITY_WINDOW_DAYS } = {}) {
  const asOfMs = parseTimestamp(asOf, 'asOf');
  const safeWindowDays = positiveInteger(windowDays, 'windowDays');
  const startMs = asOfMs - safeWindowDays * DAY_MS;
  const candidates = [];

  for (const row of Array.isArray(logs) ? logs : []) {
    if (!isGenerationLog(row)) continue;
    const timestampMs = rowTimestampMs(row);
    if (!Number.isFinite(timestampMs) || timestampMs > asOfMs) continue;
    candidates.push(normalizeSummaryCandidate(row, timestampMs));
  }

  const dedupedBeforeWindow = dedupeSummaryCandidates(candidates);
  const retained = dedupedBeforeWindow.filter((row) => row.timestampMs >= startMs).sort(compareCandidateChronologically);
  const successes = retained.filter((row) => row.status === GENERATION_SUCCESS_STATUS);
  const failures = retained.filter((row) => row.status !== GENERATION_SUCCESS_STATUS);
  const timeouts = retained.filter((row) => row.timedOut);

  const modelUsages = retained.map((row) => row.modelUsage);
  const reportedUsageCount = modelUsages.filter((usage) => usage?.status === 'reported').length;
  const partialUsageCount = modelUsages.filter((usage) => usage?.status === 'partial').length;
  const unavailableUsageCount = retained.length - reportedUsageCount - partialUsageCount;
  const tokenTotals = summarizeTokenTotals(modelUsages.filter(Boolean));

  const costEstimates = retained.map((row) => row.costEstimate);
  const estimatedCosts = costEstimates.filter((cost) => cost?.status === 'estimated');
  const unavailableCostCount = costEstimates.filter((cost) => cost?.status === 'unavailable').length + costEstimates.filter((cost) => cost == null).length;

  const stages = Object.fromEntries(AI_GENERATION_STAGE_NAMES.map((stageName) => [stageName, summarizeStage(retained.map((row) => row.stages[stageName]))]));
  const successfulDurationMs = summarizeLatency(successes.map((row) => row.durationMs));

  return {
    window: {
      type: 'rolling',
      days: safeWindowDays,
      startAt: new Date(startMs).toISOString(),
      endAt: new Date(asOfMs).toISOString(),
      bounds: 'inclusive'
    },
    totalCount: retained.length,
    successCount: successes.length,
    failureCount: failures.length,
    timeoutCount: timeouts.length,
    successRate: percentage(successes.length, retained.length),
    timeoutRate: percentage(timeouts.length, retained.length),
    failureReasons: countLabels(failures, (row) => row.failureReason, 'reason'),
    failureStages: countLabels(failures, (row) => row.failureStage, 'stage'),
    modelUsageCoverage: {
      coveredCount: reportedUsageCount + partialUsageCount,
      reportedCount: reportedUsageCount,
      partialCount: partialUsageCount,
      unavailableCount: unavailableUsageCount,
      rate: percentage(reportedUsageCount + partialUsageCount, retained.length),
      completeRate: percentage(reportedUsageCount, retained.length),
      status: retained.length ? 'available' : 'zero-denominator'
    },
    costCoverage: {
      estimatedCount: estimatedCosts.length,
      unavailableCount: unavailableCostCount,
      rate: percentage(estimatedCosts.length, retained.length),
      status: retained.length ? 'available' : 'zero-denominator'
    },
    tokenTotals,
    costTotals: summarizeCostTotals(estimatedCosts),
    durationMs: summarizeLatency(retained.map((row) => row.durationMs)),
    successfulDurationMs,
    stages,
    deduplication: {
      eligibleRowCount: candidates.length,
      retainedBeforeWindowCount: dedupedBeforeWindow.length,
      retainedCount: retained.length,
      duplicateCount: candidates.length - dedupedBeforeWindow.length,
      missingRequestIdCount: candidates.filter((row) => !row.requestId).length,
      rule: 'requestId: latest timestamp, then highest completeness, then canonical JSON; no requestId: exact canonical content'
    }
  };
}

function normalizeAttemptUsage(attempt) {
  const source = objectOrNull(attempt);
  if (!source) return null;
  if (objectOrNull(source.modelUsage)) {
    const stored = normalizeStoredModelUsage(source.modelUsage);
    return stored
      ? {
          inputTokens: stored.inputTokens,
          outputTokens: stored.outputTokens,
          totalTokens: stored.totalTokens
        }
      : null;
  }
  return normalizeModelUsage(source, source.wireApi);
}

function normalizeSummaryCandidate(source, timestampMs) {
  const stages = normalizeAiGenerationStages(source?.stages ?? source?.stageTimingsMs);
  const modelUsage = normalizeStoredModelUsage(source?.modelUsage ?? source?.tokenUsage);
  const costEstimate = normalizeCostEstimate(source?.costEstimate);
  const failureReason = boundedString(source?.failureReason || source?.code, 80) || 'unknown';
  const rawFailureStage = boundedString(source?.failureStage, 24);
  const failureStage = AI_GENERATION_STAGE_NAMES.includes(rawFailureStage) ? rawFailureStage : 'unknown';
  const requestId = boundedString(source?.requestId, 256);
  const status = source?.status === GENERATION_SUCCESS_STATUS ? GENERATION_SUCCESS_STATUS : 'error';
  const timedOut =
    source?.timedOut === true ||
    Object.values(stages).some((stage) => stage.timedOut) ||
    looksLikeTimeout(source?.failureReason) ||
    looksLikeTimeout(source?.code);
  const durationMs = finiteNonNegativeNumberOrNull(source?.durationMs);
  const canonical = stableStringify(source);
  return {
    source,
    requestId,
    timestampMs,
    status,
    timedOut,
    failureReason,
    failureStage,
    durationMs,
    modelUsage,
    costEstimate,
    stages,
    completeness: candidateCompleteness({
      source,
      requestId,
      durationMs,
      modelUsage,
      costEstimate,
      stages,
      failureReason,
      failureStage
    }),
    canonical
  };
}

function dedupeSummaryCandidates(candidates) {
  const byKey = new Map();
  for (const candidate of candidates) {
    const key = candidate.requestId ? `request:${candidate.requestId}` : `content:${candidate.canonical}`;
    const current = byKey.get(key);
    if (!current || compareCandidatePreference(candidate, current) > 0) byKey.set(key, candidate);
  }
  return [...byKey.values()];
}

function compareCandidatePreference(left, right) {
  return left.timestampMs - right.timestampMs || left.completeness - right.completeness || compareText(left.canonical, right.canonical);
}

function compareCandidateChronologically(left, right) {
  return left.timestampMs - right.timestampMs || compareText(left.requestId || left.canonical, right.requestId || right.canonical);
}

function candidateCompleteness({ source, requestId, durationMs, modelUsage, costEstimate, stages, failureReason, failureStage }) {
  let score = requestId ? 1 : 0;
  if (durationMs != null) score += 1;
  if (boundedString(source?.provider?.name, 80)) score += 1;
  if (boundedString(source?.provider?.model, 160)) score += 1;
  if (boundedString(source?.provider?.wireApi, 40)) score += 1;
  if (modelUsage) score += modelUsage.status === 'reported' ? 4 : modelUsage.status === 'partial' ? 2 : 1;
  if (costEstimate) score += costEstimate.status === 'estimated' ? 3 : 1;
  score += Object.values(stages).filter((stage) => stage.status !== 'skipped').length;
  if (failureReason !== 'unknown') score += 1;
  if (failureStage !== 'unknown') score += 1;
  if (source?.timedOut === true) score += 1;
  return score;
}

function summarizeTokenTotals(usages) {
  const inputTokens = nullableCounter();
  const outputTokens = nullableCounter();
  const totalTokens = nullableCounter();
  let reportedCount = 0;
  let partialCount = 0;
  for (const usage of usages) {
    if (!usage) continue;
    if (usage.status === 'reported') reportedCount += 1;
    if (usage.status === 'partial') partialCount += 1;
    inputTokens.add(usage.inputTokens);
    outputTokens.add(usage.outputTokens);
    totalTokens.add(usage.totalTokens);
  }
  return {
    inputTokens: inputTokens.value(),
    outputTokens: outputTokens.value(),
    totalTokens: totalTokens.value(),
    sampleCount: reportedCount + partialCount,
    status:
      reportedCount + partialCount === 0
        ? 'no-samples'
        : partialCount > 0 || [inputTokens.value(), outputTokens.value(), totalTokens.value()].some((value) => value == null)
          ? 'partial'
          : 'available'
  };
}

function summarizeCostTotals(costs) {
  const byCurrency = new Map();
  for (const cost of costs) {
    const current = byCurrency.get(cost.currency) ?? { currency: cost.currency, amount: 0, sampleCount: 0 };
    current.amount += cost.amount;
    current.sampleCount += 1;
    byCurrency.set(cost.currency, current);
  }
  const totalsByCurrency = [...byCurrency.values()]
    .map((item) => ({ ...item, amount: roundNumber(item.amount, 12) }))
    .sort((left, right) => left.currency.localeCompare(right.currency));
  return {
    sampleCount: costs.length,
    currency: totalsByCurrency.length === 1 ? totalsByCurrency[0].currency : null,
    amount: totalsByCurrency.length === 1 ? totalsByCurrency[0].amount : null,
    totalsByCurrency,
    status: !costs.length ? 'no-samples' : totalsByCurrency.length === 1 ? 'available' : 'mixed-currency'
  };
}

function summarizeStage(stageRows) {
  const latency = summarizeLatency(stageRows.filter((stage) => stage.status !== 'skipped').map((stage) => stage.durationMs));
  const statusCounts = Object.fromEntries(
    [...AI_GENERATION_STAGE_STATUSES].map((status) => [status, stageRows.filter((stage) => stage.status === status).length])
  );
  const attemptedCount = stageRows.length - statusCounts.skipped;
  const timedOutCount = stageRows.filter((stage) => stage.timedOut).length;
  return {
    ...latency,
    attemptedCount,
    timedOutCount,
    timeoutRate: percentage(timedOutCount, attemptedCount),
    statusCounts
  };
}

function summarizeLatency(values) {
  const samples = values
    .map(finiteNonNegativeNumberOrNull)
    .filter((value) => value != null)
    .sort((left, right) => left - right);
  return {
    p50: nearestRank(samples, 0.5),
    p90: nearestRank(samples, 0.9),
    p95: nearestRank(samples, 0.95),
    sampleCount: samples.length,
    status: samples.length ? 'available' : 'no-samples'
  };
}

function countLabels(rows, valueOf, keyName) {
  const counts = new Map();
  for (const row of rows) {
    const value = boundedString(valueOf(row), 80) || 'unknown';
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ [keyName]: value, count }))
    .sort((left, right) => right.count - left.count || compareText(left[keyName], right[keyName]));
}

function selectUsageKeys(usage, protocol) {
  const hasResponsesKeys = ['input_tokens', 'output_tokens'].some((key) => Object.prototype.hasOwnProperty.call(usage, key));
  const hasChatKeys = ['prompt_tokens', 'completion_tokens'].some((key) => Object.prototype.hasOwnProperty.call(usage, key));
  const hasNormalizedKeys = ['inputTokens', 'outputTokens', 'totalTokens'].some((key) => Object.prototype.hasOwnProperty.call(usage, key));
  if (hasNormalizedKeys) return { input: 'inputTokens', output: 'outputTokens', total: 'totalTokens' };
  if (protocol === 'responses' || (!protocol && hasResponsesKeys)) {
    return { input: 'input_tokens', output: 'output_tokens', total: 'total_tokens' };
  }
  if (protocol === 'chat-completions' || (!protocol && hasChatKeys)) {
    return { input: 'prompt_tokens', output: 'completion_tokens', total: 'total_tokens' };
  }
  if (Object.prototype.hasOwnProperty.call(usage, 'total_tokens')) {
    return { input: 'input_tokens', output: 'output_tokens', total: 'total_tokens' };
  }
  return null;
}

function normalizeWireApi(value) {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replaceAll('_', '-');
  if (normalized.includes('response')) return 'responses';
  if (normalized.includes('chat')) return 'chat-completions';
  return '';
}

function isGenerationLog(row) {
  return objectOrNull(row) && (!row.kind || row.kind === GENERATION_KIND);
}

function rowTimestampMs(row) {
  const value = row?.createdAt ?? row?.occurredAt ?? row?.timestamp;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : Number.NaN;
  if (typeof value !== 'string' || !value.trim()) return Number.NaN;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.NaN;
}

function parseTimestamp(value, name) {
  const timestamp =
    value instanceof Date ? value.getTime() : typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(timestamp)) throw new TypeError(`${name} must be a valid date or epoch timestamp`);
  return timestamp;
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new TypeError(`${name} must be a positive integer`);
  return number;
}

function nullableCounter() {
  let count = 0;
  let sum = 0;
  let overflowed = false;
  return {
    add(value) {
      if (!Number.isSafeInteger(value) || value < 0) return;
      if (!Number.isSafeInteger(sum + value)) {
        overflowed = true;
        return;
      }
      count += 1;
      sum += value;
    },
    value() {
      return count && !overflowed ? sum : null;
    }
  };
}

function safeIntegerSumOrNull(left, right) {
  const total = left + right;
  return Number.isSafeInteger(total) && total >= 0 ? total : null;
}

function nonNegativeSafeIntegerOrNull(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function finiteNonNegativeNumberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function environmentNonNegativeNumberOrNull(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function objectOrNull(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function boundedString(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function looksLikeTimeout(value) {
  const text = boundedString(value, 160).toLowerCase();
  return text.includes('timeout') || text.includes('timed out') || text.includes('超时');
}

function nearestRank(sortedValues, percentile) {
  if (!sortedValues.length) return null;
  return sortedValues[Math.max(0, Math.ceil(sortedValues.length * percentile) - 1)];
}

function percentage(numerator, denominator) {
  return denominator > 0 ? roundNumber((numerator / denominator) * 100, 1) : null;
}

function roundNumber(value, precision) {
  const factor = 10 ** precision;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function compareText(left, right) {
  const leftText = String(left);
  const rightText = String(right);
  return leftText === rightText ? 0 : leftText < rightText ? -1 : 1;
}

function stableStringify(value) {
  const seen = new WeakSet();
  return JSON.stringify(stableValue(value, seen));
}

function stableValue(value, seen) {
  if (typeof value === 'bigint') return value.toString();
  if (!value || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) return null;
    return value;
  }
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => stableValue(item, seen));
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key], seen)])
  );
}

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AI_COST_ESTIMATE_BASIS,
  buildAiObservabilitySummary,
  estimateModelCost,
  normalizeAiGenerationStages,
  normalizeCostEstimate,
  normalizeModelUsage,
  normalizeStoredModelUsage,
  summarizeModelUsage
} from '../../server/analytics/aiObservability.mjs';

const AS_OF = '2026-08-30T00:00:00.000Z';

function reportedUsage(inputTokens = 100, outputTokens = 20, extra = {}) {
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    attemptCount: 1,
    reportedAttemptCount: 1,
    status: 'reported',
    ...extra
  };
}

function costEstimate(amount = 0.001, currency = 'CNY') {
  return {
    status: 'estimated',
    model: 'gpt-5.6-sol',
    currency,
    amount,
    inputPricePerMillion: 2.5,
    outputPricePerMillion: 10,
    basis: AI_COST_ESTIMATE_BASIS
  };
}

function stages(seed = 100, overrides = {}) {
  return {
    model: { durationMs: seed, status: 'completed', timedOut: false },
    geocoding: { durationMs: seed + 10, status: 'completed', timedOut: false },
    routing: { durationMs: seed + 20, status: 'completed', timedOut: false },
    persistence: { durationMs: seed + 30, status: 'completed', timedOut: false },
    ...overrides
  };
}

function generation(requestId, createdAt, extra = {}) {
  return {
    requestId,
    kind: 'generate-routebook',
    status: 'ok',
    createdAt,
    durationMs: 1000,
    modelUsage: reportedUsage(),
    costEstimate: costEstimate(),
    stages: stages(),
    ...extra
  };
}

test('normalizes Responses and Chat Completions usage without estimating missing values', () => {
  assert.deepEqual(
    normalizeModelUsage(
      {
        usage: { input_tokens: 120, output_tokens: 30, total_tokens: 150 }
      },
      'responses'
    ),
    {
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150
    }
  );
  assert.deepEqual(
    normalizeModelUsage(
      {
        usage: { prompt_tokens: 80, completion_tokens: 20 }
      },
      'chat_completions'
    ),
    {
      inputTokens: 80,
      outputTokens: 20,
      totalTokens: 100
    }
  );
  assert.deepEqual(
    normalizeModelUsage({
      input_tokens: 12,
      total_tokens: 15
    }),
    {
      inputTokens: 12,
      outputTokens: null,
      totalTokens: 15
    }
  );
  assert.equal(normalizeModelUsage({ usage: {} }), null);
  assert.equal(
    normalizeModelUsage(
      {
        usage: { input_tokens: '120', output_tokens: Infinity, total_tokens: -1 }
      },
      'responses'
    ),
    null
  );
});

test('summarizes every model attempt and distinguishes reported, partial, and unavailable coverage', () => {
  assert.deepEqual(
    summarizeModelUsage([
      {
        wireApi: 'responses',
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 }
      },
      {
        wireApi: 'chat_completions',
        usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 }
      }
    ]),
    {
      inputTokens: 150,
      outputTokens: 30,
      totalTokens: 180,
      attemptCount: 2,
      reportedAttemptCount: 2,
      status: 'reported'
    }
  );

  assert.deepEqual(
    summarizeModelUsage([
      { usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 }, wireApi: 'responses' },
      { status: 'timeout', usage: null },
      { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 }, wireApi: 'chat_completions' }
    ]),
    {
      inputTokens: 150,
      outputTokens: 30,
      totalTokens: 180,
      attemptCount: 3,
      reportedAttemptCount: 2,
      status: 'partial'
    }
  );

  assert.deepEqual(summarizeModelUsage([{ status: 'timeout' }, { status: 'cancelled' }]), {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    attemptCount: 2,
    reportedAttemptCount: 0,
    status: 'unavailable'
  });
  assert.deepEqual(summarizeModelUsage([]), {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    attemptCount: 0,
    reportedAttemptCount: 0,
    status: 'unavailable'
  });
});

test('strict stored usage normalization drops extra fields and rejects inconsistent or malformed values', () => {
  assert.deepEqual(
    normalizeStoredModelUsage({
      ...reportedUsage(),
      bearer: 'must-not-pass',
      nested: { prompt: 'must-not-pass' }
    }),
    reportedUsage()
  );
  assert.deepEqual(
    normalizeStoredModelUsage({
      inputTokens: 100,
      outputTokens: null,
      totalTokens: null,
      attemptCount: 1,
      reportedAttemptCount: 1,
      status: 'partial'
    }),
    {
      inputTokens: 100,
      outputTokens: null,
      totalTokens: null,
      attemptCount: 1,
      reportedAttemptCount: 1,
      status: 'partial'
    }
  );
  assert.equal(normalizeStoredModelUsage({ ...reportedUsage(), inputTokens: '100' }), null);
  assert.equal(normalizeStoredModelUsage({ ...reportedUsage(), reportedAttemptCount: 2 }), null);
  assert.equal(normalizeStoredModelUsage({ ...reportedUsage(), status: 'partial' }), null);
  assert.equal(
    normalizeStoredModelUsage({
      inputTokens: Infinity,
      outputTokens: null,
      totalTokens: null,
      attemptCount: 1,
      reportedAttemptCount: 1,
      status: 'partial'
    }),
    null
  );
});

test('estimates cost only from complete usage and the established environment price snapshot', () => {
  const config = {
    AI_INPUT_COST_PER_MILLION_TOKENS: '2.5',
    AI_OUTPUT_COST_PER_MILLION_TOKENS: '10',
    AI_COST_CURRENCY: 'cny'
  };
  const usage = {
    inputTokens: 150,
    outputTokens: 30,
    totalTokens: 180,
    attemptCount: 2,
    reportedAttemptCount: 2,
    status: 'reported'
  };
  assert.deepEqual(estimateModelCost({ modelUsage: usage, model: 'gpt-5.6-sol', config }), {
    status: 'estimated',
    model: 'gpt-5.6-sol',
    currency: 'CNY',
    amount: 0.000675,
    inputPricePerMillion: 2.5,
    outputPricePerMillion: 10,
    basis: AI_COST_ESTIMATE_BASIS
  });
  assert.deepEqual(
    estimateModelCost({ modelUsage: usage, model: 'another-model', config }),
    {
      status: 'estimated',
      model: 'another-model',
      currency: 'CNY',
      amount: 0.000675,
      inputPricePerMillion: 2.5,
      outputPricePerMillion: 10,
      basis: AI_COST_ESTIMATE_BASIS
    },
    'the active provider model is recorded as the snapshot; pricing has no second model route'
  );

  const unavailable = estimateModelCost({ modelUsage: usage, model: 'gpt-5.6-sol', config: {} });
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.amount, null);
  assert.equal(unavailable.currency, 'USD');
  assert.equal(
    estimateModelCost({
      modelUsage: { ...usage, status: 'partial', reportedAttemptCount: 1 },
      model: 'gpt-5.6-sol',
      config
    }).status,
    'unavailable'
  );
  assert.equal(estimateModelCost({ modelUsage: usage, model: '', config }).status, 'unavailable');
  assert.equal(
    estimateModelCost({
      modelUsage: usage,
      model: 'gpt-5.6-sol',
      config: { ...config, AI_INPUT_COST_PER_MILLION_TOKENS: 'Infinity' }
    }).status,
    'unavailable'
  );
});

test('strict cost normalization returns an allowlist and rejects malformed estimates', () => {
  assert.deepEqual(
    normalizeCostEstimate({
      ...costEstimate(),
      apiKey: 'must-not-pass',
      arbitrary: { value: 1 }
    }),
    costEstimate()
  );
  assert.equal(normalizeCostEstimate({ ...costEstimate(), amount: '0.001' }), null);
  assert.equal(normalizeCostEstimate({ ...costEstimate(), amount: Infinity }), null);
  assert.equal(normalizeCostEstimate({ ...costEstimate(), status: 'model-mismatch', amount: null }), null);
  assert.deepEqual(
    normalizeCostEstimate({
      status: 'unavailable',
      model: 'gpt-5.6-sol',
      currency: 'CNY',
      amount: null,
      inputPricePerMillion: null,
      outputPricePerMillion: null,
      basis: AI_COST_ESTIMATE_BASIS,
      secret: 'must-not-pass'
    }),
    {
      status: 'unavailable',
      model: 'gpt-5.6-sol',
      currency: 'CNY',
      amount: null,
      inputPricePerMillion: null,
      outputPricePerMillion: null,
      basis: AI_COST_ESTIMATE_BASIS
    }
  );
});

test('normalizes the four generation stages with fixed status and numeric boundaries', () => {
  assert.deepEqual(
    normalizeAiGenerationStages({
      model: { durationMs: 1200, status: 'completed', timedOut: false, prompt: 'drop' },
      geocoding: { durationMs: 40, status: 'degraded', timedOut: true },
      routing: { durationMs: '30', status: 'failed', timedOut: false },
      unexpected: { durationMs: 1, status: 'completed' }
    }),
    {
      model: { durationMs: 1200, status: 'completed', timedOut: false },
      geocoding: { durationMs: 40, status: 'degraded', timedOut: true },
      routing: { durationMs: null, status: 'failed', timedOut: false },
      persistence: { durationMs: null, status: 'skipped', timedOut: false }
    }
  );
});

test('returns explicit zero-denominator states for an empty 30-day window', () => {
  const summary = buildAiObservabilitySummary([], { asOf: AS_OF });
  assert.equal(summary.window.days, 30);
  assert.equal(summary.window.startAt, '2026-07-31T00:00:00.000Z');
  assert.equal(summary.totalCount, 0);
  assert.equal(summary.successRate, null);
  assert.equal(summary.timeoutRate, null);
  assert.equal(summary.modelUsageCoverage.rate, null);
  assert.equal(summary.modelUsageCoverage.status, 'zero-denominator');
  assert.equal(summary.costCoverage.rate, null);
  assert.equal(summary.costCoverage.status, 'zero-denominator');
  assert.deepEqual(summary.durationMs, {
    p50: null,
    p90: null,
    p95: null,
    sampleCount: 0,
    status: 'no-samples'
  });
  assert.equal(summary.stages.model.timeoutRate, null);
});

test('uses inclusive window bounds and deterministic latest requestId deduplication', () => {
  const first = generation('duplicate', '2026-08-01T00:00:00.000Z', {
    durationMs: 100,
    modelUsage: null,
    costEstimate: null,
    stages: {}
  });
  const latest = generation('duplicate', '2026-08-02T00:00:00.000Z', {
    durationMs: 900,
    modelUsage: null,
    costEstimate: null,
    stages: {}
  });
  const equalTimeSparse = generation('equal-time', '2026-08-03T00:00:00.000Z', {
    durationMs: null,
    modelUsage: null,
    costEstimate: null,
    stages: {}
  });
  const equalTimeComplete = generation('equal-time', '2026-08-03T00:00:00.000Z', { durationMs: 300 });
  const rows = [
    generation('boundary', '2026-07-31T00:00:00.000Z', { durationMs: 50 }),
    generation('stale', '2026-07-30T23:59:59.999Z'),
    generation('future', '2026-08-30T00:00:00.001Z'),
    { ...generation('invalid', 'not-a-date') },
    { ...generation('other-kind', '2026-08-01T00:00:00.000Z'), kind: 'ocr-guide' },
    first,
    latest,
    equalTimeSparse,
    equalTimeComplete
  ];
  const forward = buildAiObservabilitySummary(rows, { asOf: AS_OF });
  const reversed = buildAiObservabilitySummary([...rows].reverse(), { asOf: AS_OF });

  assert.deepEqual(reversed, forward, 'deduplication must not depend on input order');
  assert.equal(forward.totalCount, 3);
  assert.equal(forward.deduplication.eligibleRowCount, 6);
  assert.equal(forward.deduplication.duplicateCount, 2);
  assert.deepEqual(forward.durationMs, {
    p50: 300,
    p90: 900,
    p95: 900,
    sampleCount: 3,
    status: 'available'
  });
});

test('aggregates success, timeout, failures, coverage, totals, and all stage percentiles', () => {
  const rows = [
    generation('r1', '2026-08-01T00:00:00.000Z', { durationMs: 100, stages: stages(10), costEstimate: costEstimate(0.001) }),
    generation('r2', '2026-08-02T00:00:00.000Z', { durationMs: 200, stages: stages(20), costEstimate: costEstimate(0.002) }),
    generation('r3', '2026-08-03T00:00:00.000Z', {
      status: 'error',
      durationMs: 300,
      failureReason: 'timeout',
      failureStage: 'model',
      timedOut: true,
      modelUsage: {
        inputTokens: 50,
        outputTokens: null,
        totalTokens: null,
        attemptCount: 2,
        reportedAttemptCount: 1,
        status: 'partial'
      },
      costEstimate: {
        status: 'unavailable',
        model: 'gpt-5.6-sol',
        currency: 'CNY',
        amount: null,
        inputPricePerMillion: 2.5,
        outputPricePerMillion: 10,
        basis: AI_COST_ESTIMATE_BASIS
      },
      stages: stages(30, {
        model: { durationMs: 30, status: 'failed', timedOut: true },
        geocoding: { durationMs: null, status: 'skipped', timedOut: false },
        routing: { durationMs: null, status: 'skipped', timedOut: false },
        persistence: { durationMs: null, status: 'skipped', timedOut: false }
      })
    }),
    generation('r4', '2026-08-04T00:00:00.000Z', {
      status: 'error',
      durationMs: 400,
      failureReason: 'bad-output',
      failureStage: 'model',
      modelUsage: null,
      costEstimate: { ...costEstimate(0.004), amount: '0.004' },
      stages: stages(40, { model: { durationMs: 40, status: 'failed', timedOut: false } })
    }),
    generation('r5', '2026-08-05T00:00:00.000Z', {
      status: 'error',
      durationMs: 500,
      failureReason: 'bad-output',
      failureStage: 'persistence',
      modelUsage: null,
      costEstimate: costEstimate(0.005, 'USD'),
      stages: stages(50, { persistence: { durationMs: 80, status: 'failed', timedOut: false } })
    })
  ];

  const summary = buildAiObservabilitySummary(rows, { asOf: AS_OF });
  assert.equal(summary.totalCount, 5);
  assert.equal(summary.successCount, 2);
  assert.equal(summary.failureCount, 3);
  assert.equal(summary.timeoutCount, 1);
  assert.equal(summary.successRate, 40);
  assert.equal(summary.timeoutRate, 20);
  assert.deepEqual(summary.failureReasons, [
    { reason: 'bad-output', count: 2 },
    { reason: 'timeout', count: 1 }
  ]);
  assert.deepEqual(summary.failureStages, [
    { stage: 'model', count: 2 },
    { stage: 'persistence', count: 1 }
  ]);
  assert.deepEqual(summary.modelUsageCoverage, {
    coveredCount: 3,
    reportedCount: 2,
    partialCount: 1,
    unavailableCount: 2,
    rate: 60,
    completeRate: 40,
    status: 'available'
  });
  assert.deepEqual(summary.tokenTotals, {
    inputTokens: 250,
    outputTokens: 40,
    totalTokens: 240,
    sampleCount: 3,
    status: 'partial'
  });
  assert.deepEqual(summary.costCoverage, {
    estimatedCount: 3,
    unavailableCount: 2,
    rate: 60,
    status: 'available'
  });
  assert.deepEqual(summary.costTotals, {
    sampleCount: 3,
    currency: null,
    amount: null,
    totalsByCurrency: [
      { currency: 'CNY', amount: 0.003, sampleCount: 2 },
      { currency: 'USD', amount: 0.005, sampleCount: 1 }
    ],
    status: 'mixed-currency'
  });
  assert.deepEqual(summary.durationMs, {
    p50: 300,
    p90: 500,
    p95: 500,
    sampleCount: 5,
    status: 'available'
  });
  assert.deepEqual(summary.successfulDurationMs, {
    p50: 100,
    p90: 200,
    p95: 200,
    sampleCount: 2,
    status: 'available'
  });
  assert.equal(summary.stages.model.p50, 30);
  assert.equal(summary.stages.model.p90, 50);
  assert.equal(summary.stages.model.p95, 50);
  assert.equal(summary.stages.model.sampleCount, 5);
  assert.equal(summary.stages.model.timedOutCount, 1);
  assert.equal(summary.stages.model.timeoutRate, 20);
  assert.deepEqual(summary.stages.model.statusCounts, {
    completed: 3,
    degraded: 0,
    failed: 2,
    skipped: 0
  });
});

test('rejects invalid summary time configuration', () => {
  assert.throws(() => buildAiObservabilitySummary([], { asOf: 'not-a-date' }), /asOf/);
  assert.throws(() => buildAiObservabilitySummary([], { asOf: AS_OF, windowDays: 0 }), /windowDays/);
});

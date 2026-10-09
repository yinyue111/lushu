import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAiObservabilitySummary } from '../../server/analytics/aiObservability.mjs';
import { calculateOperationalMetrics } from '../../server/analytics/operationalMetrics.mjs';

const AS_OF = '2026-08-24T00:00:00.000Z';

/** @param {string} profileId @param {string} publicId @param {string} createdAt @param {any} [durationMs] @param {Record<string, any>} [extra] */
function generation(profileId, publicId, createdAt, durationMs = 1000, extra = {}) {
  return {
    id: `generation-${profileId}-${publicId}-${createdAt}`,
    requestId: `request-${profileId}-${publicId}`,
    kind: 'generate-routebook',
    status: 'ok',
    profileId,
    publicId,
    createdAt,
    durationMs,
    ...extra
  };
}

function exposure(profileId, routeId, surface, createdAt, id = `${profileId}-${routeId}-${surface}-${createdAt}`) {
  return {
    id,
    itemType: 'journey-event',
    profileId,
    routeId,
    itemId: routeId,
    surface,
    createdAt
  };
}

test('returns explicit no-sample and zero-denominator states', () => {
  const result = calculateOperationalMetrics({ asOf: AS_OF });

  assert.deepEqual(result.funnel.generationLatencyMs, {
    p50: null,
    p90: null,
    p95: null,
    sampleCount: 0,
    status: 'no-samples'
  });
  assert.equal(result.funnel.aiObservability.totalCount, 0);
  assert.equal(result.funnel.aiObservability.timeoutRate, null);
  assert.equal(result.metricDefinitions.aiObservability.status, 'no-samples');
  for (const metric of ['sevenDayReturnRate', 'repeatGenerationRate', 'aiSatisfactionRate', 'unusableComplaintRate']) {
    assert.equal(result.funnel[metric], null);
    assert.equal(result.funnel[`${metric}Status`], 'zero-denominator');
  }
  assert.equal(result.metricDefinitions.repeatGeneration.window.startAt, '2026-07-25T00:00:00.000Z');
  assert.equal(result.metricDefinitions.sevenDayReturn.cohortWindow.startAt, '2026-07-18T00:00:00.000Z');
  assert.equal(result.metricDefinitions.sevenDayReturn.cohortWindow.endAt, '2026-08-17T00:00:00.000Z');
});

test('generation latency uses nearest-rank percentiles and ignores duplicate, failed, invalid, stale, and future rows', () => {
  const aiLogs = [
    generation('p1', 'r1', '2026-08-01T00:00:00.000Z', 100),
    generation('p1', 'r1', '2026-08-02T00:00:00.000Z', 999, { requestId: 'request-p1-r1' }),
    generation('p2', 'r2', '2026-08-03T00:00:00.000Z', 200),
    generation('p3', 'r3', '2026-08-04T00:00:00.000Z', 300),
    generation('p4', 'r4', '2026-08-05T00:00:00.000Z', 400),
    generation('p5', 'r5', '2026-08-06T00:00:00.000Z', 500),
    generation('p6', 'r6', '2026-08-07T00:00:00.000Z', 'invalid'),
    generation('p10', 'r10', '2026-08-07T00:00:00.000Z', null),
    generation('p7', 'r7', '2026-07-24T23:59:59.999Z', 10),
    generation('p8', 'r8', '2026-08-24T00:00:00.001Z', 10),
    generation('p9', 'r9', '2026-08-08T00:00:00.000Z', 10, { status: 'error' })
  ];

  const result = calculateOperationalMetrics({ aiLogs, asOf: AS_OF });

  assert.deepEqual(result.funnel.generationLatencyMs, {
    p50: 400,
    p90: 999,
    p95: 999,
    sampleCount: 5,
    status: 'available'
  });
});

test('reuses the shared request-level AI observability summary without changing the legacy latency field shape', () => {
  const aiLogs = [
    generation('p1', 'r1', '2026-08-01T00:00:00.000Z', 100, {
      requestId: 'same-request',
      stages: {
        model: { durationMs: 80, status: 'completed', timedOut: false }
      }
    }),
    generation('p1', 'r1', '2026-08-02T00:00:00.000Z', 200, {
      requestId: 'same-request',
      stages: {
        model: { durationMs: 160, status: 'completed', timedOut: false }
      }
    }),
    generation('p2', 'r2', '2026-08-03T00:00:00.000Z', 300, {
      status: 'error',
      failureReason: 'timeout',
      failureStage: 'model',
      timedOut: true,
      stages: {
        model: { durationMs: 300, status: 'failed', timedOut: true }
      }
    })
  ];
  const result = calculateOperationalMetrics({ aiLogs, asOf: AS_OF });
  const direct = buildAiObservabilitySummary(aiLogs, { asOf: AS_OF, windowDays: 30 });

  assert.deepEqual(result.funnel.aiObservability, direct);
  assert.deepEqual(result.funnel.generationLatencyMs, direct.successfulDurationMs);
  assert.equal(result.funnel.aiObservability.totalCount, 2);
  assert.equal(result.funnel.aiObservability.timeoutRate, 50);
  assert.deepEqual(result.funnel.aiObservability.failureReasons, [{ reason: 'timeout', count: 1 }]);
  assert.deepEqual(result.funnel.aiObservability.failureStages, [{ stage: 'model', count: 1 }]);
  assert.equal(result.metricDefinitions.aiObservability.status, 'available');
});

test('repeat generation deduplicates stable profile and route pairs', () => {
  const aiLogs = [
    generation('p1', 'r1', '2026-08-01T00:00:00.000Z'),
    generation('p1', 'r1', '2026-08-02T00:00:00.000Z', 1200, { requestId: 'duplicate-route' }),
    generation('p1', 'r2', '2026-08-03T00:00:00.000Z'),
    generation('p2', 'r3', '2026-08-04T00:00:00.000Z'),
    generation('anonymous', 'r4', '2026-08-05T00:00:00.000Z'),
    generation('anonymous', 'r5', '2026-08-06T00:00:00.000Z'),
    generation('p3', '', '2026-08-07T00:00:00.000Z')
  ];

  const { funnel } = calculateOperationalMetrics({ aiLogs, asOf: AS_OF });

  assert.equal(funnel.generatorProfiles, 2);
  assert.equal(funnel.repeatGeneratorProfiles, 1);
  assert.equal(funnel.repeatGenerationRate, 50);
  assert.equal(funnel.repeatGenerationRateStatus, 'available');
});

test('satisfaction keeps the latest decision while complaints count each generated journey once', () => {
  const aiLogs = [
    generation('p1', 'r1', '2026-08-01T00:00:00.000Z'),
    generation('p1', 'r2', '2026-08-01T00:00:00.000Z'),
    generation('p2', 'r3', '2026-08-01T00:00:00.000Z')
  ];
  const duplicatePositive = exposure('p1', 'r1', 'ai-satisfaction-positive', '2026-08-02T00:00:00.000Z', 'feedback-a');
  const exposures = [
    duplicatePositive,
    { ...duplicatePositive },
    exposure('p1', 'r1', 'ai-satisfaction-negative', '2026-08-03T00:00:00.000Z', 'feedback-b'),
    exposure('p1', 'r2', 'ai-satisfaction-negative', '2026-08-02T00:00:00.000Z', 'feedback-c'),
    exposure('p1', 'r2', 'ai-satisfaction-positive', '2026-08-04T00:00:00.000Z', 'feedback-d'),
    exposure('p2', 'r3', 'ai-satisfaction-positive', '2026-08-05T00:00:00.000Z', 'feedback-e'),
    exposure('p1', 'r1', 'route-unusable-complaint', '2026-08-06T00:00:00.000Z', 'complaint-a'),
    exposure('p1', 'r1', 'route-unusable-complaint', '2026-08-06T00:00:01.000Z', 'complaint-b'),
    exposure('p2', 'r3', 'route-unusable-complaint', '2026-08-07T00:00:00.000Z', 'complaint-c'),
    exposure('p9', 'r9', 'ai-satisfaction-positive', '2026-08-05T00:00:00.000Z', 'unmatched-feedback'),
    exposure('p9', 'r9', 'route-unusable-complaint', '2026-08-05T00:00:00.000Z', 'unmatched-complaint')
  ];

  const forward = calculateOperationalMetrics({ aiLogs, exposures, asOf: AS_OF });
  const reversed = calculateOperationalMetrics({
    aiLogs: [...aiLogs].reverse(),
    exposures: [...exposures].reverse(),
    asOf: AS_OF
  });

  assert.deepEqual(reversed, forward, 'input order must not change stable deduplication');
  assert.equal(forward.funnel.aiFeedbackJourneys, 3);
  assert.equal(forward.funnel.aiSatisfiedJourneys, 2);
  assert.equal(forward.funnel.aiSatisfactionRate, 66.7);
  assert.equal(forward.funnel.unusableComplaintEligibleJourneys, 3);
  assert.equal(forward.funnel.unusableComplaintJourneys, 2);
  assert.equal(forward.funnel.unusableComplaintRate, 66.7);
});

test('seven-day return includes exact 24-hour and 7-day boundaries and excludes immature or out-of-cohort profiles', () => {
  const aiLogs = [
    generation('p1', 'r1', '2026-08-17T00:00:00.000Z'),
    generation('p2', 'r2', '2026-08-16T00:00:00.000Z'),
    generation('p3', 'r3', '2026-08-15T00:00:00.000Z'),
    generation('p4', 'r4', '2026-08-17T00:00:00.001Z'),
    generation('p5', 'r5', '2026-07-18T00:00:00.000Z'),
    generation('p6', 'r6', '2026-07-17T23:59:59.999Z'),
    generation('p7', 'r7', '2026-08-14T00:00:00.000Z'),
    generation('p7', 'r7', '2026-08-16T00:00:00.000Z', 1000, { requestId: 'duplicated-p7-generation' })
  ];
  const activityRows = [
    exposure('p1', 'r1', 'routebook-view', '2026-08-18T00:00:00.000Z', 'p1-exact-24h'),
    exposure('p1', 'r1', 'routebook-view', '2026-08-18T00:00:00.000Z', 'p1-duplicate'),
    exposure('p2', 'r2', 'routebook-view', '2026-08-23T00:00:00.000Z', 'p2-exact-7d'),
    exposure('p3', 'r3', 'routebook-view', '2026-08-22T00:00:00.001Z', 'p3-after-7d'),
    exposure('p5', 'r5', 'routebook-view', '2026-07-18T23:59:59.999Z', 'p5-before-24h')
  ];

  const { funnel } = calculateOperationalMetrics({ aiLogs, activityRows, asOf: AS_OF });

  assert.equal(funnel.eligibleSevenDayProfiles, 5);
  assert.equal(funnel.sevenDayReturnedProfiles, 2);
  assert.equal(funnel.sevenDayReturnRate, 40);
  assert.equal(funnel.sevenDayReturnRateStatus, 'available');
});

test('rejects invalid time configuration instead of silently changing the metric window', () => {
  assert.throws(() => calculateOperationalMetrics(), /asOf/);
  assert.throws(() => calculateOperationalMetrics({ asOf: 'not-a-date' }), /asOf/);
  assert.throws(() => calculateOperationalMetrics({ asOf: AS_OF, reportingWindowDays: 0 }), /reportingWindowDays/);
});

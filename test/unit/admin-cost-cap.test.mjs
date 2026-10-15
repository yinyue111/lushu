import assert from 'node:assert/strict';
import { test } from 'node:test';
import { costCapState } from '../../server/admin/costCap.mjs';
import { dashboardWarnings, generationCostToday } from '../../server/admin/dashboard.mjs';

const now = Date.parse('2026-10-14T04:00:00Z');
const at = new Date(now - 60000).toISOString();

test('unpriced calls are counted, not valued at 0 → lower bound', () => {
  const out = generationCostToday(
    [
      { kind: 'generate-routebook', status: 'ok', createdAt: at, costEstimate: { status: 'estimated', amount: 0.5 } },
      { kind: 'generate-routebook', status: 'ok', createdAt: at, costEstimate: { status: 'unavailable', amount: null } },
      { kind: 'generate-routebook', status: 'error', createdAt: at },
      { kind: 'generate-routebook', status: 'cancelled', createdAt: at }
    ],
    now
  );
  assert.equal(out.generationUsd, 0.5);
  assert.equal(out.unknownCostCount, 2, 'failed calls without a price count too; cancelled ones do not');
});

test('cost cap: auto enforces only when all prices are known', () => {
  assert.equal(costCapState({ knownUsd: 1, unknownCostCount: 0 }, { mode: 'auto', limitUsd: 0, missing: [] }).enforcing, false);
  const missing = costCapState({ knownUsd: 1, unknownCostCount: 0 }, { mode: 'auto', limitUsd: 5, missing: ['grok-x'] });
  assert.equal(missing.enforcing, false);
  assert.match(missing.reason, /grok-x 没有单价/);
  assert.equal(costCapState({ knownUsd: 1, unknownCostCount: 3 }, { mode: 'auto', limitUsd: 5, missing: [] }).enforcing, false);
  assert.equal(costCapState({ knownUsd: 1, unknownCostCount: 0 }, { mode: 'auto', limitUsd: 5, missing: [] }).enforcing, true);
  assert.equal(costCapState({ knownUsd: 1, unknownCostCount: 3 }, { mode: 'on', limitUsd: 5, missing: ['m'] }).enforcing, true);
  assert.equal(costCapState({ knownUsd: 1, unknownCostCount: 0 }, { mode: 'off', limitUsd: 5, missing: [] }).enforcing, false);
});

test('overview warns when registration is open by default (unset)', () => {
  const snap = (mode, overrides = {}) => /** @type {any} */ ({ values: { 'registration.mode': mode }, overrides });
  const unset = dashboardWarnings(snap('open'), {});
  assert.equal(unset.length, 1);
  assert.match(unset[0].text, /默认值/);
  assert.match(dashboardWarnings(snap('open'), { REGISTRATION_MODE: 'open' })[0].text, /对所有人开放/);
  assert.deepEqual(dashboardWarnings(snap('invite', { 'registration.mode': 'invite' }), {}), []);
});

test('pricing: a blank price is rejected (never stored as 0); source and date are kept', async () => {
  const { parseSetting } = await import('../../server/config/runtimeSchema.mjs');
  assert.throws(() => parseSetting('model.pricing', { 'grok-x': { input: '', output: 2 } }), /都要填/);
  assert.deepEqual(parseSetting('model.pricing', { 'grok-x': { input: 1, output: 2, source: '中继账单 2026-10', asOf: '2026-10-01' } }), {
    'grok-x': { input: 1, output: 2, source: '中继账单 2026-10', asOf: '2026-10-01' }
  });
});

test('细品 failure copy is honest about an automatic 轻快 attempt', async () => {
  const { generationFailureCopy } = await import('../../src/lib/generationJob.js');
  assert.match(generationFailureCopy({ code: 'MODEL_ERROR', suggestFast: true }).detail, /可以用「轻快」马上重试/);
  assert.match(generationFailureCopy({ code: 'MODEL_ERROR', suggestFast: true, fallbackTried: { mode: 'fast' } }).detail, /已经自动换「轻快」试过一次/);
});

test('shipped model.pricing defaults: official USD/1M for grok-4.7 and gemini-3.8-flash-high', async () => {
  const { DEFAULT_MODEL_PRICING } = await import('../../server/config/modelPricingDefaults.mjs');
  const { envSetting, parseSetting } = await import('../../server/config/runtimeSchema.mjs');
  assert.equal(DEFAULT_MODEL_PRICING['grok-4.7'].input, 2);
  assert.equal(DEFAULT_MODEL_PRICING['grok-4.7'].output, 6);
  assert.equal(DEFAULT_MODEL_PRICING['gemini-3.8-flash-high'].input, 0.75);
  assert.equal(DEFAULT_MODEL_PRICING['gemini-3.8-flash-high'].output, 3.75);
  assert.match(DEFAULT_MODEL_PRICING['grok-4.7'].source, /docs\.x\.ai/);
  assert.match(DEFAULT_MODEL_PRICING['gemini-3.8-flash-high'].source, /ai\.google\.dev\/pricing/);
  assert.equal(DEFAULT_MODEL_PRICING['grok-4.7'].asOf, '2026-10-16');
  const shipped = envSetting('model.pricing');
  assert.deepEqual(shipped['grok-4.7'], parseSetting('model.pricing', DEFAULT_MODEL_PRICING)['grok-4.7']);
  assert.ok(shipped['gemini-3.8-flash-high']);
});

test('with shipped prices, estimateModelCost yields a real USD amount (dashboard can show 估算 $X)', async () => {
  const { estimateModelCost } = await import('../../server/analytics/aiObservability.mjs');
  const { modelPricingFor, modelHasPrice } = await import('../../server/admin/cost.mjs');
  const { DEFAULT_MODEL_PRICING } = await import('../../server/config/modelPricingDefaults.mjs');
  const runtime = await import('../../server/config/runtime.mjs');
  runtime.resetRuntimeConfigForTests();
  // Fresh env snapshot picks up DEFAULT_MODEL_PRICING via envSetting('model.pricing').
  runtime.configureRuntimeConfig({
    store: () => ({
      async latestConfig() {
        return null;
      }
    })
  });
  await runtime.refreshConfig();
  assert.equal(modelHasPrice('grok-4.7'), true);
  assert.equal(modelHasPrice('gemini-3.8-flash-high'), true);
  assert.equal(modelHasPrice('totally-unknown-model'), false);
  const usage = {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    totalTokens: 2_000_000,
    attemptCount: 1,
    reportedAttemptCount: 1,
    status: 'reported'
  };
  const grok = estimateModelCost({ modelUsage: usage, model: 'grok-4.7', config: modelPricingFor('grok-4.7') });
  assert.equal(grok.status, 'estimated');
  assert.equal(grok.amount, DEFAULT_MODEL_PRICING['grok-4.7'].input + DEFAULT_MODEL_PRICING['grok-4.7'].output);
  const gemini = estimateModelCost({
    modelUsage: usage,
    model: 'gemini-3.8-flash-high',
    config: modelPricingFor('gemini-3.8-flash-high')
  });
  assert.equal(gemini.status, 'estimated');
  assert.equal(gemini.amount, 0.75 + 3.75);
  // Mixed day: one estimated + one unavailable → 「估算 $X，另有 N 次没有单价」
  const out = generationCostToday(
    [
      {
        kind: 'generate-routebook',
        status: 'ok',
        createdAt: at,
        costEstimate: {
          status: 'estimated',
          amount: gemini.amount,
          model: 'gemini-3.8-flash-high',
          currency: 'USD',
          inputPricePerMillion: 0.75,
          outputPricePerMillion: 3.75,
          basis: 'environment-price-snapshot'
        }
      },
      { kind: 'generate-routebook', status: 'ok', createdAt: at, costEstimate: { status: 'unavailable', amount: null } }
    ],
    now
  );
  assert.equal(out.generationUsd, 4.5);
  assert.equal(out.unknownCostCount, 1);
});

test('cost headline copy: 估算 $X / 估算 $X，另有 N 次没有单价; never 至少', async () => {
  const { formatCostHeadline, COST_ESTIMATE_BIAS_HINT } = await import('../../admin/src/costDisplay.js');
  assert.equal(formatCostHeadline({ totalUsd: 1.23456, lowerBound: false }), '估算 $1.2346');
  assert.equal(formatCostHeadline({ totalUsd: 0.5, lowerBound: true, unknownCostCount: 3 }), '估算 $0.5000，另有 3 次没有单价');
  assert.equal(COST_ESTIMATE_BIAS_HINT, '按官方标价估算；命中缓存时偏高，超长上下文时偏低');
  assert.doesNotMatch(formatCostHeadline({ totalUsd: 1, lowerBound: true, unknownCostCount: 1 }), /至少/);
});

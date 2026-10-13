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

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildActivationFunnel, buildTrustBehavior, funnelKey, medianMinutesToFirstSuccess } from '../server/analytics/funnelEvents.mjs';

const k = (id) => funnelKey(id);
const at = (min) => new Date(Date.UTC(2026, 9, 1, 0, min)).toISOString();

test('cohort funnel follows the same people across register alias', () => {
  const rows = [
    { event: 'home_view', key: k('dev-a'), createdAt: at(0) },
    { event: 'create_start', key: k('dev-a'), createdAt: at(1) },
    { event: 'register_complete', key: k('acct-a'), aliasOf: k('dev-a'), createdAt: at(2) },
    { event: 'home_view', key: k('dev-b'), createdAt: at(0) },
    // c registers without ever visiting: not in the cohort
    { event: 'register_complete', key: k('acct-c'), createdAt: at(3) },
    { event: 'share_open', key: k('acct-a'), createdAt: at(30) }
  ];
  const logs = [
    { kind: 'generate-routebook', status: 'ok', profileId: 'acct-a', createdAt: at(5) },
    { kind: 'generate-routebook', status: 'ok', profileId: 'acct-c', createdAt: at(5) }
  ];
  const steps = buildActivationFunnel(rows, logs);
  assert.deepEqual(steps.map((s) => s.count), [2, 1, 1, 1, 1]);
  assert.equal(steps.cohortSize, 2);
  assert.deepEqual(medianMinutesToFirstSuccess(rows, logs), { median: 4, samples: 1 });
});

test('trust behavior rates', () => {
  const rows = [
    { event: 'route_view', key: 'a', createdAt: at(0) },
    { event: 'route_view', key: 'b', createdAt: at(0) },
    { event: 'confirm_open', key: 'a', createdAt: at(1) },
    { event: 'confirm_open', key: 'a', createdAt: at(2) },
    { event: 'revisit', key: 'b', createdAt: at(3) }
  ];
  const out = buildTrustBehavior(rows);
  assert.equal(out.confirm_open.count, 2);
  assert.equal(out.confirmOpenRate, 50);
  assert.equal(out.revisitRate, 50);
});

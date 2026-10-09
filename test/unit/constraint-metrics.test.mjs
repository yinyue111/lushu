import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildConstraintSatisfaction } from '../../server/analytics/constraintMetrics.mjs';

const routebook = (publicId, mustGo, budget) => ({
  publicId,
  validations: [...(mustGo ? [{ id: 'edit-constraints', state: mustGo }] : []), ...(budget ? [{ id: 'edit-budget', state: budget }] : [])]
});

test('constraint satisfaction counts only decided checks and scopes to generated routes', () => {
  const routebooks = [
    routebook('r1', '已纳入', '可控'),
    routebook('r2', '未完全满足', '超预算'),
    routebook('r3', '需人工确认', '区间待复核'),
    routebook('r4', '未设置', '无预算约束'),
    routebook('r5', null, null),
    routebook('manual', '未完全满足', '超预算')
  ];
  const result = buildConstraintSatisfaction(routebooks, { routeIds: new Set(['r1', 'r2', 'r3', 'r4', 'r5']) });
  assert.equal(result.routebooks, 5);
  assert.deepEqual([result.checksSatisfied, result.checksDecided, result.satisfactionRate], [2, 4, 50]);
  assert.deepEqual([result.mustGoAvoid['needs-review'], result.mustGoAvoid['not-set'], result.mustGoAvoid.missing], [1, 1, 1]);
  assert.equal(buildConstraintSatisfaction([routebook('x', '未设置', '无预算约束')]).satisfactionRate, null, 'no decided checks → null, not 0');
});

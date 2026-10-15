import assert from 'node:assert/strict';
import test from 'node:test';
import { routeMetaText } from '../../src/lib/routeMeta.js';
import { isOperatorMetric } from '../../src/lib/trust.js';

test('share meta never prints 0 天', () => {
  assert.equal(routeMetaText('苏州', [], [{ name: 'a' }, { name: 'b' }]), '苏州 · 2 站');
  assert.equal(routeMetaText('苏州', [], [{ day: 'Day 1' }, { day: 'Day 2' }]), '苏州 · 2 天 · 2 站');
  assert.equal(routeMetaText('杭州', ['Day 1', 'Day 2', 'Day 3'], [{}]), '杭州 · 3 天 · 1 站');
});

test('operator metrics are hidden from the public share page', () => {
  assert.equal(isOperatorMetric({ label: '复制转化' }), true);
  assert.equal(isOperatorMetric({ label: '平均修改' }), true);
  assert.equal(isOperatorMetric({ label: '有效到达' }), false);
});

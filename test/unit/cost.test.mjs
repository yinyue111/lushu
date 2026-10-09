import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatCostInfo, normalizeCostInfo, parseCostText, stopCostInfo, sumStopCosts } from '../../src/lib/cost.js';

const pick = (info) => ({ min: info.min, max: info.max, free: info.free, known: info.known, reservationRequired: info.reservationRequired });

test('legacy cost text: review regression cases (F01)', () => {
  // Several prices joined by "+" are added up item by item.
  const tea = parseCostText('门票 75 元 + 茶 50 元');
  assert.deepEqual(pick(tea), { min: 125, max: 125, free: false, known: true, reservationRequired: false });
  assert.deepEqual(
    tea.items.map((item) => [item.label, item.min]),
    [
      ['门票', 75],
      ['茶', 50]
    ]
  );
  // Free with a reservation note is 0, not unknown.
  assert.deepEqual(pick(parseCostText('免费（需预约）')), { min: 0, max: 0, free: true, known: true, reservationRequired: true });
  // Durations are not money.
  assert.deepEqual(pick(parseCostText('约 2 小时 / 30 元')), { min: 30, max: 30, free: false, known: true, reservationRequired: false });
  // Dates are not a 10–2026 range.
  assert.deepEqual(pick(parseCostText('2026-10-01 开放 门票20')), { min: 20, max: 20, free: false, known: true, reservationRequired: false });
  // Ranges keep both bounds.
  const range = parseCostText('80-120 元');
  assert.deepEqual(pick(range), { min: 80, max: 120, free: false, known: true, reservationRequired: false });
  assert.equal(range.amount, null);
});

test('legacy cost text: other shapes', () => {
  assert.equal(parseCostText('人均 60，加缆车 40').min, 100);
  assert.equal(parseCostText('人均 60，加缆车 40').per, 'person');
  assert.equal(parseCostText('1,200 元').min, 1200);
  assert.equal(parseCostText('开放时间 8:30-17:00 门票 30 元').min, 30);
  assert.equal(parseCostText('包船 150 元').per, 'group');
  const alternatives = parseCostText('门票 40 元，学生 20 元');
  assert.equal(alternatives.min, 40, 'alternatives are not summed');
  assert.match(alternatives.note, /多个价格/);
  assert.equal(parseCostText('待估算').known, false);
  assert.equal(parseCostText('').known, false);
});

test('structured cost is validated, not trusted', () => {
  const info = normalizeCostInfo({ amount: null, min: 120, max: 80, unit: 'ticket', per: 'person', free: false, reservationRequired: true, note: 'x' });
  assert.equal(info.min, 80);
  assert.equal(info.max, 120);
  assert.equal(info.known, true);
  assert.equal(normalizeCostInfo({ amount: -5 }).known, false);
  assert.equal(normalizeCostInfo({ free: true, amount: 30 }).max, 0);
  assert.equal(normalizeCostInfo({ unit: 'bogus', per: 'bogus', amount: 1 }).unit, null);
  assert.equal(normalizeCostInfo('30 元'), null);
});

test('an edited cost string is never shadowed by a stale structured value', () => {
  const stale = { cost: '50 元', costInfo: { amount: 30, text: '30 元', source: 'model' } };
  assert.equal(stopCostInfo(stale).min, 50);
  const current = { cost: '30 元/人', costInfo: { amount: 30, per: 'person', text: '30 元/人', source: 'model' } };
  assert.equal(stopCostInfo(current).source, 'model');
});

test('display text and sums keep unknowns separate', () => {
  assert.equal(formatCostInfo(parseCostText('免费（需预约）')), '免费（需预约）');
  assert.equal(formatCostInfo(parseCostText('80-120 元')), '80–120 元');
  assert.equal(formatCostInfo(parseCostText('30元/人')), '30 元/人');
  assert.equal(formatCostInfo(parseCostText('待估算')), '费用待补充');
  const sum = sumStopCosts([{ cost: '80-120 元' }, { cost: '待估算' }, { cost: '免费（需预约）' }]);
  assert.deepEqual([sum.min, sum.max, sum.knownCount, sum.unknownCount, sum.reservationCount], [80, 120, 2, 1, 1]);
});

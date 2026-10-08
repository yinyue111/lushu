import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  costWeight,
  familyWeight,
  greedyModeOrder,
  indoorWeight,
  modeSlug,
  orderedDays,
  reorderStopsByMode,
  variantSummary
} from '../../src/lib/routeModes.js';

test('mode slugs and summaries', () => {
  assert.equal(modeSlug('雨天'), 'rainy');
  assert.equal(modeSlug('其他'), 'custom');
  assert.match(variantSummary('低预算'), /费用/);
  assert.equal(variantSummary('夜游'), '按夜游偏好生成可切换路线。');
});

test('stop weights', () => {
  assert.equal(indoorWeight({ name: '浙江省博物馆' }), 2);
  assert.equal(indoorWeight({ name: '断桥' }), 0);
  assert.equal(costWeight({ cost: '人均 80 元' }), 80);
  assert.equal(costWeight({ cost: '免费' }), 0);
  assert.equal(familyWeight({ name: '太子湾公园' }), 2);
  assert.equal(familyWeight(null), 0);
});

const stop = (name, lat, lng, extra = {}) => ({ name, lat, lng, geoConfidence: 90, ...extra });

test('greedy order follows nearest neighbour from the anchor', () => {
  const a = stop('A', 30.0, 120.0);
  const b = stop('B', 30.0, 120.1);
  const c = stop('C', 30.0, 120.02);
  assert.deepEqual(
    greedyModeOrder([b, c], a, '少走路').map((item) => item.name),
    ['C', 'B']
  );
  assert.deepEqual(greedyModeOrder([], a, '少走路'), []);
});

test('rainy mode prefers indoor stops even when farther', () => {
  const anchor = stop('起点', 30.0, 120.0);
  const outdoor = stop('白堤', 30.0, 120.01);
  const museum = stop('博物馆', 30.0, 120.05);
  assert.deepEqual(
    greedyModeOrder([outdoor, museum], anchor, '雨天').map((item) => item.name),
    ['博物馆', '白堤']
  );
});

test('budget mode prefers cheaper stops', () => {
  const anchor = stop('起点', 30.0, 120.0);
  const pricey = stop('餐厅', 30.0, 120.001, { cost: '300' });
  const cheap = stop('公园', 30.0, 120.02, { cost: '0' });
  assert.deepEqual(
    greedyModeOrder([pricey, cheap], anchor, '低预算').map((item) => item.name),
    ['公园', '餐厅']
  );
});

test('days keep their preferred order and the previous day end anchors the next day', () => {
  const stops = [
    stop('D2-far', 30.0, 121.0, { day: 'Day 2' }),
    stop('D1-a', 30.0, 120.0, { day: 'Day 1' }),
    stop('D2-near', 30.0, 120.01, { day: 'Day 2' }),
    stop('D3', 30.0, 120.0, { day: 'Day 3' }),
    stop('no-day', 30.0, 120.0)
  ];
  assert.deepEqual(orderedDays(stops, ['Day 2', 'Day 9']), ['Day 2', 'Day 1', 'Day 3']);
  const reordered = reorderStopsByMode(stops, '少走路', { preferredDays: ['Day 1', 'Day 2', 'Day 3'] });
  assert.deepEqual(
    reordered.map((item) => item.name),
    ['D1-a', 'no-day', 'D2-near', 'D2-far', 'D3']
  );
  assert.equal(reordered.length, stops.length);
  assert.deepEqual(reorderStopsByMode(null, '雨天'), []);
});

test('stops without navigable coordinates fall back to area grouping and input order', () => {
  const anchor = { name: '起点', area: '西湖' };
  const other = { name: '河坊街', area: '上城' };
  const sameArea = { name: '苏堤', area: '西湖' };
  const lowConfidence = { name: '低置信', area: '上城', lat: 30, lng: 120, geoConfidence: 20 };
  assert.deepEqual(
    greedyModeOrder([other, lowConfidence, sameArea], anchor, '少走路').map((item) => item.name),
    ['苏堤', '河坊街', '低置信']
  );
});

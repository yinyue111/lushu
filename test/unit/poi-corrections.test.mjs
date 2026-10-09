import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyPoiCorrection, isHoursOrClosureCorrection, normalizePoiCorrection } from '../../server/poi/knowledge.mjs';

test('split form fields map to one category each', () => {
  assert.equal(classifyPoiCorrection({ field: '开放时间' }), 'hours');
  assert.equal(classifyPoiCorrection({ field: '价格' }), 'price');
  assert.equal(classifyPoiCorrection({ field: '闭店/暂停' }), 'closure');
  assert.equal(classifyPoiCorrection({ field: '位置坐标' }), 'location');
  assert.equal(classifyPoiCorrection({ field: '排队/拥挤' }), 'crowd');
});

test('a price correction never counts as an hours/closure signal', () => {
  assert.equal(isHoursOrClosureCorrection({ field: '价格', suggestedValue: '门票涨到 15 元' }), false);
  // Legacy combined option: decided from the text.
  assert.equal(isHoursOrClosureCorrection({ field: '开放时间/价格', suggestedValue: '门票已涨到 15 元' }), false);
  assert.equal(isHoursOrClosureCorrection({ field: '开放时间/价格', suggestedValue: '周一闭馆' }), true);
  // "其他" saying it has closed is a closure.
  assert.equal(isHoursOrClosureCorrection({ field: '其他', suggestedValue: '已经关门了' }), true);
});

test('stored corrections carry the category', () => {
  const stored = normalizePoiCorrection({ stopName: '法喜寺', field: '价格', suggestedValue: '免费' });
  assert.equal(stored.category, 'price');
  assert.equal(normalizePoiCorrection({ stopName: '法喜寺', category: 'closure' }).category, 'closure');
  assert.equal(normalizePoiCorrection({ stopName: '法喜寺', category: 'bogus', field: '开放时间' }).category, 'hours');
});

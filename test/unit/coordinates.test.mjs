import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  coordinateForName,
  coordinateReviewLabel,
  distanceKm,
  fallbackCoordinate,
  isNavigableCoordinate,
  isValidCoordinate,
  normalizeCoordinate,
  routeLegLabel
} from '../../src/lib/coordinates.js';

test('M4: coordinateForName requires an exact name (no substring matches)', () => {
  assert.deepEqual(coordinateForName('柳浪闻莺'), { lat: 30.242, lng: 120.1617 });
  assert.deepEqual(coordinateForName('  柳浪闻莺  '), { lat: 30.242, lng: 120.1617 });
  // Previously `key.includes('')` matched the first POI for an empty name.
  assert.equal(coordinateForName(''), null);
  assert.equal(coordinateForName(undefined), null);
  // Previously substring matches in both directions returned another POI's coordinates.
  assert.equal(coordinateForName('西湖柳浪闻莺公园'), null);
  assert.equal(coordinateForName('北山'), null);
  assert.equal(coordinateForName('路'), null);
  assert.equal(coordinateForName('toString'), null, 'prototype keys are not POIs');
});

test('M4: coordinateForName is scoped to the city when provided', () => {
  assert.ok(coordinateForName('武康路', '上海'));
  assert.ok(coordinateForName('武康路', '上海市'));
  assert.equal(coordinateForName('武康路', '杭州'), null);
  assert.ok(coordinateForName('平江路', '苏州'));
  assert.equal(coordinateForName('平江路', '杭州'), null);
});

test('isValidCoordinate bounds', () => {
  assert.equal(isValidCoordinate(30, 120), true);
  assert.equal(isValidCoordinate(91, 0), false);
  assert.equal(isValidCoordinate(0, -181), false);
  assert.equal(isValidCoordinate(Number.NaN, 0), false);
});

test('fallbackCoordinate degrades from city to region to country and is never navigable', () => {
  const city = fallbackCoordinate('杭州', 0);
  assert.equal(city.source, 'city-center');
  assert.equal(city.navigationDisabled, true);
  const unknown = fallbackCoordinate('不存在的城市', 0);
  assert.equal(unknown.source, 'country-center');
  assert.equal(unknown.radiusMeters, 300000);
});

test('normalizeCoordinate: low-confidence input is kept but not navigable', () => {
  const low = /** @type {any} */ (normalizeCoordinate({ lat: 30.1, lng: 120.1, geoConfidence: 40 }, '杭州', 0));
  assert.equal(low.fallback, true);
  assert.equal(low.navigationDisabled, true);
  const exact = /** @type {any} */ (normalizeCoordinate({ lat: 30.1, lng: 120.1, geoConfidence: 90 }, '杭州', 0));
  assert.equal(exact.fallback, false);
  assert.equal(exact.confidence, 90);
  const missing = /** @type {any} */ (normalizeCoordinate({ name: '' }, '杭州', 0));
  assert.equal(missing.source, 'city-center', 'empty names fall back to the city centre, not a random POI');
});

test('distanceKm / navigability / labels', () => {
  const a = { lat: 30.242, lng: 120.1617, geoConfidence: 90 };
  const b = { lat: 30.2432, lng: 120.1696, geoConfidence: 90 };
  const km = distanceKm(a, b);
  assert.ok(km > 0.7 && km < 0.8, String(km));
  assert.equal(distanceKm(a, { ...b, geoConfidence: 30 }), null, 'low confidence legs are not measured');
  assert.equal(isNavigableCoordinate({ ...a, coordinateSource: 'city-center' }), false);
  assert.equal(coordinateReviewLabel(a), '可导航');
  assert.equal(coordinateReviewLabel({ lat: 30, lng: 120, geoConfidence: 10 }), '定位待复核');
  assert.equal(coordinateReviewLabel({}), '缺少坐标');
  assert.match(routeLegLabel(a, b), /^步行约 \d+ 分钟 · 直线 [\d.]+ km（路线还没查）$/);
  assert.equal(routeLegLabel(a, {}), '路程待核对');
});

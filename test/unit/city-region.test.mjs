import test from 'node:test';
import assert from 'node:assert/strict';
import { isCityOpenForGeneration, JZH_CITIES } from '../../src/lib/chinaCities.js';
import { sanitizePayload } from '../../server/ai/generate.mjs';
import { trustedCities } from '../../src/lib/content.js';

test('江浙沪 cities are open; others closed unless region=all', () => {
  for (const city of ['上海', '南京', '苏州', '宁波', '嘉兴', '舟山']) assert.ok(isCityOpenForGeneration(city), city);
  for (const city of ['成都', '北京', '合肥']) assert.equal(isCityOpenForGeneration(city), false, city);
  assert.ok(isCityOpenForGeneration('成都', 'all'));
  assert.equal(JZH_CITIES.length, 25);
});

test('trusted cities stay a subset of the open region (only cities with reviewed data)', () => {
  assert.ok(trustedCities.every((city) => JZH_CITIES.includes(city)));
});

test('generation rejects a city outside the beta region with a plain message', () => {
  assert.throws(() => sanitizePayload({ city: '成都', guide: '宽窄巷子' }), (error) => error.code === 'CITY_NOT_OPEN' && /江浙沪/.test(error.message));
  assert.doesNotThrow(() => sanitizePayload({ city: '南京', guide: '夫子庙' }));
});

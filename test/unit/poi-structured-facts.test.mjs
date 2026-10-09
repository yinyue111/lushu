import assert from 'node:assert/strict';
import { test } from 'node:test';
import { currentPoiPrice, operationalOpenHoursFromFacts } from '../../server/poi/catalog.mjs';
import { buildOpeningHoursValidation, normalizePoiOpenHours } from '../../server/routebooks/normalize.mjs';
import { sumStopCosts } from '../../src/lib/cost.js';

const NOW = Date.parse('2026-10-09T00:00:00Z');
const evidence = [
  { id: 'ev', url: 'https://example.com/official', title: '官网公告', capturedAt: '2026-09-20', reviewStatus: 'approved', sourceType: 'official' }
];
const poi = (facts) => ({ poiId: 'poi-x', city: '杭州', name: '某馆', reviewStatus: 'approved', evidence, facts, sourceKind: 'operational' });

test('reviewed hours fact becomes structured hours with source, verifiedAt and expiry', () => {
  /** @type {any} */
  const hours = operationalOpenHoursFromFacts(
    poi([
      { id: 'f1', field: '开放时间', value: '09:00-17:00（16:30 停止入场），周一闭馆', reviewStatus: 'approved', evidenceIds: ['ev'], validUntil: '2027-01-01' }
    ])
  );
  assert.deepEqual(
    [hours.openTime, hours.closeTime, hours.lastEntryTime, hours.closedWeekdays, hours.validUntil, hours.source.label],
    ['09:00', '17:00', '16:30', [1], '2027-01-01', '官网公告']
  );
  assert.ok(hours.verifiedAt.startsWith('2026-09-20'));
  const usable = normalizePoiOpenHours(hours, { sourceKind: 'operational' }, NOW);
  assert.equal(usable.planningUsable, true);
  assert.equal(usable.lastEntryKnown, true);
  const expired = normalizePoiOpenHours({ ...hours, validUntil: '2026-01-01' }, { sourceKind: 'operational' }, NOW);
  assert.equal(expired.planningUsable, false);
  const noExpiry = normalizePoiOpenHours({ ...hours, validUntil: '' }, { sourceKind: 'operational' }, NOW);
  assert.equal(noExpiry.planningUsable, false, 'operational hours without a validity window are not planning facts');
  const noEvidence = operationalOpenHoursFromFacts(
    poi([{ id: 'f2', field: '开放时间', value: '09:00-17:00', reviewStatus: 'approved', evidenceIds: [], validUntil: '2027-01-01' }])
  );
  assert.equal(normalizePoiOpenHours(noEvidence, { sourceKind: 'operational' }, NOW).planningUsable, false);
});

test('opening check compares arrival and stay for always-open seeds and reports gaps honestly', () => {
  const stops = [
    { name: '柳浪闻莺', day: 'Day 1', time: '09:00', stay: '60 分钟' },
    { name: '某不存在的店', day: 'Day 1', time: '11:00', stay: '60 分钟' }
  ];
  const partial = buildOpeningHoursValidation(stops, '杭州', '2026-10-10', { nowMs: NOW });
  assert.equal(partial.state, '部分待复核');
  assert.match(partial.detail, /1 个站点没有可用营业事实/);
  const pass = buildOpeningHoursValidation([stops[0], { name: '南宋御街', day: 'Day 1', time: '11:00', stay: '1 小时' }], '杭州', '2026-10-10', { nowMs: NOW });
  assert.equal(pass.state, '通过');
});

test('reviewed price: only fresh evidence-backed facts, preferred in budget sums', () => {
  const trusted = poi([{ id: 'p1', field: '门票', value: '门票 40 元', reviewStatus: 'approved', evidenceIds: ['ev'], validUntil: '2027-01-01' }]);
  const price = currentPoiPrice(trusted, NOW);
  assert.equal(price.text, '门票 40 元');
  assert.equal(price.expiresAt, '2027-01-01');
  assert.equal(currentPoiPrice({ ...trusted, facts: [{ ...trusted.facts[0], validUntil: '2026-01-01' }] }, NOW), null);
  assert.equal(currentPoiPrice({ ...trusted, facts: [{ ...trusted.facts[0], evidenceIds: [] }] }, NOW), null);
  assert.equal(currentPoiPrice({ ...trusted, sourceKind: 'seed' }, NOW), null);
  const sum = sumStopCosts([{ cost: '约 100 元', verifiedPrice: { costInfo: { known: true, min: 40, max: 40, amount: 40, unit: 'ticket' } } }]);
  assert.equal(sum.min, 40);
});

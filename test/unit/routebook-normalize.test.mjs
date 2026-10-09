import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMoney, parseMoneyRange, sumMoneyRanges } from '../../server/lib/util.mjs';
import {
  buildOpeningHoursValidation,
  buildRoutebookMetrics,
  buildRoutebookValidations,
  normalizePoiOpenHours,
  parseBudgetConstraint
} from '../../server/routebooks/normalize.mjs';

function stop(name, cost, day = 'Day 1', time = '10:00') {
  return {
    id: name,
    name,
    day,
    time,
    stay: '60 分钟',
    cost,
    lat: 30.24,
    lng: 120.16,
    geoConfidence: 90
  };
}

test('money parsing preserves ranges, thousands separators, free and unknown values', () => {
  assert.deepEqual(parseMoneyRange('80-120 元'), {
    raw: '80-120 元',
    known: true,
    isRange: true,
    min: 80,
    max: 120,
    estimate: 100,
    reason: 'range'
  });
  assert.equal(parseMoney('1,200 元'), 1200);
  assert.equal(parseMoney('1，200 元'), 1200);
  assert.equal(parseMoney('80-120 元'), 100);
  assert.equal(parseMoneyRange('免费').known, true);
  assert.equal(parseMoneyRange('待估算').known, false);
  assert.deepEqual(sumMoneyRanges(['80-120 元', '1,200 元', '待估算']), {
    knownCount: 2,
    unknownCount: 1,
    allKnown: false,
    min: 1280,
    max: 1320,
    estimate: 1300
  });
});

test('budget validation states full-trip, daily and per-person semantics without false precision', () => {
  assert.equal(parseBudgetConstraint('全程人均 1,500').scope, 'trip');
  assert.equal(parseBudgetConstraint('每日人均 500').scope, 'daily');
  assert.equal(parseBudgetConstraint('每日人均 500').perPerson, true);
  assert.equal(parseBudgetConstraint('人均 900').semanticsLabel, '全程人均');

  const twoDays = [stop('A', '400-600 元', 'Day 1'), stop('B', '400-600 元', 'Day 2')];
  const daily = buildRoutebookValidations(twoDays, [], '测试', {
    city: '未知城市',
    travelDate: '2026-10-09',
    constraints: { budget: '每日 500' }
  }).find((item) => item.id === 'edit-budget');
  assert.equal(daily.state, '区间待复核');
  assert.match(daily.detail, /每日预算/);
  assert.match(daily.detail, /按 2 天折算/);

  const fullTrip = buildRoutebookValidations([stop('A', '80-120 元'), stop('B', '1,200 元')], [], '测试', {
    city: '未知城市',
    travelDate: '2026-10-09',
    constraints: { budget: '全程人均 1,500' }
  }).find((item) => item.id === 'edit-budget');
  assert.equal(fullTrip.state, '可控');
  assert.match(fullTrip.detail, /全程人均预算/);
  assert.match(fullTrip.detail, /1,280–1,320 元/);

  const unknownCost = buildRoutebookValidations([stop('A', '待估算'), stop('B', '80-120 元')], [], '测试', {
    city: '未知城市',
    travelDate: '2026-10-09',
    constraints: { budget: '全程 500' }
  }).find((item) => item.id === 'edit-budget');
  assert.equal(unknownCost.state, '部分待复核');
  assert.match(unknownCost.detail, /待补充/);

  const metrics = buildRoutebookMetrics([stop('A', '80-120 元'), stop('B', '1,200 元')]);
  assert.equal(metrics.find((item) => item.label === '预算估算').value, '约 1,280–1,320 元');
});

test('opening validation never claims through when arrival window is unknown', () => {
  const friday = buildOpeningHoursValidation([stop('浙江美术馆', '80 元', 'Day 1', '18:00')], '杭州', '2026-10-09');
  assert.equal(friday.state, '部分待复核');
  assert.match(friday.detail, /到达时段\/最晚入场未知/);

  const monday = buildOpeningHoursValidation([stop('浙江美术馆', '80 元')], '杭州', '2026-10-12');
  assert.equal(monday.state, '需复核');
  assert.match(monday.detail, /缺少有效证据|已过期/);

  const unknown = buildOpeningHoursValidation([stop('不存在的地点', '80 元')], '杭州', '2026-10-09');
  assert.equal(unknown.state, '无数据');
  assert.match(unknown.detail, /到达时段和最晚入场/);
});

test('expired or evidence-free operational hours are not planning usable', () => {
  const now = Date.parse('2026-10-09T00:00:00.000Z');
  const stale = normalizePoiOpenHours(
    { closedWeekdays: [], openTime: '09:00', closeTime: '17:00', validUntil: '2026-10-08' },
    { sourceKind: 'operational' },
    now
  );
  assert.equal(stale.stale, true);
  assert.equal(stale.planningUsable, false);

  const noEvidence = normalizePoiOpenHours({ closedWeekdays: [], openTime: '09:00', closeTime: '17:00' }, { sourceKind: 'operational' }, now);
  assert.equal(noEvidence.hasEvidence, false);
  assert.equal(noEvidence.planningUsable, false);

  const noLatestEntry = normalizePoiOpenHours(
    { closedWeekdays: [], openTime: '09:00', closeTime: '17:00', evidenceId: 'e1' },
    { sourceKind: 'operational' },
    now
  );
  assert.equal(noLatestEntry.timingKnown, false);
  assert.equal(noLatestEntry.planningUsable, false);
});

test('constraint validation surfaces missing must-go and included avoid terms', () => {
  const validations = buildRoutebookValidations([stop('西湖'), stop('灵隐寺')], [], '测试', {
    city: '杭州',
    travelDate: '2026-10-09',
    constraints: { mustGo: '西湖、法喜寺', avoid: '灵隐寺、商业街' }
  });
  const constraint = validations.find((item) => item.id === 'edit-constraints');
  assert.equal(constraint.state, '未完全满足');
  assert.match(constraint.detail, /法喜寺/);
  assert.match(constraint.detail, /灵隐寺/);
});

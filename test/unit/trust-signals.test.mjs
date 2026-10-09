import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coordinateVerificationLevel, findPlaceMention, routeEvidenceScore, stopEvidenceSignals } from '../../src/lib/trustSignals.js';
import { deriveStopProvenance, normalizeStopProvenance } from '../../server/trust/provenance.mjs';
import {
  buildConstraintValidation,
  buildRoutebookValidations,
  calculateRouteTrustScore,
  normalizeRoutebookForStorage,
  serverProcessLogs,
  signImportedSource,
  systemMetrics,
  systemValidations
} from '../../server/routebooks/normalize.mjs';

const stop = (name, extra = {}) => ({ name, day: 'Day 1', time: '10:00', lat: 30.24, lng: 120.16, ...extra });

test('evidence score ignores the model self-score', () => {
  const low = [stop('A', { score: 99, coordinateSource: 'model', navigationDisabled: true, provenance: { origin: 'model' } })];
  const high = [stop('A', { score: 1, coordinateSource: 'model', navigationDisabled: true, provenance: { origin: 'model' } })];
  assert.equal(calculateRouteTrustScore(low), calculateRouteTrustScore(high));
  // AI-added stop with an approximate coordinate: 0 + 10 + 0.
  assert.equal(calculateRouteTrustScore(low), 10);
  assert.equal(calculateRouteTrustScore([]), 0);
});

test('verifiable signals add up per stop', () => {
  const best = stopEvidenceSignals(
    stop('法喜寺', { coordinateSource: 'known-poi', provenance: { origin: 'user-guide', reviewedPoi: true, verifiedFactCount: 2 } })
  );
  assert.equal(best.points, 100);
  assert.equal(coordinateVerificationLevel(stop('x', { coordinateSource: 'city-center' })), 'none');
  assert.equal(coordinateVerificationLevel(stop('x', { coordinateSource: 'amap-geocode', navigationDisabled: true })), 'approximate');
  const { score, breakdown } = routeEvidenceScore([
    stop('a', { coordinateSource: 'known-poi', provenance: { origin: 'user-guide', reviewedPoi: true } }),
    stop('b', { provenance: { origin: 'model' } })
  ]);
  assert.equal(score, Math.round((80 + 10) / 2));
  assert.equal(breakdown.origins['user-guide'], 1);
  assert.equal(breakdown.origins.model, 1);
  assert.equal(breakdown.reviewedPoiCount, 1);
});

test('mentions are whole-name/alias matches only', () => {
  assert.equal(findPlaceMention('想去柳浪闻莺公园看看', '柳浪闻莺'), '柳浪闻莺');
  assert.equal(findPlaceMention('想去西湖', '西湖国宾馆'), '');
});

test('provenance at generation: user text, signed imported source, model', () => {
  const sources = [{ title: '杭州攻略', excerpt: '推荐茅家埠和龙井茶园', proof: 'x', status: 'fetched' }];
  assert.equal(deriveStopProvenance({ name: '法喜寺' }, { city: '杭州', guideText: '想去法喜寺' }).origin, 'user-guide');
  assert.equal(deriveStopProvenance({ name: '茅家埠' }, { city: '杭州', guideText: '想去法喜寺', importedSources: sources }).origin, 'imported-source');
  assert.equal(deriveStopProvenance({ name: '某某咖啡' }, { city: '杭州', guideText: '想去法喜寺' }).origin, 'model');
  // Reviewed catalog match is recorded independently of origin.
  assert.equal(deriveStopProvenance({ name: '某某咖啡' }, { city: '杭州' }).reviewedPoi, false);
  assert.equal(deriveStopProvenance({ name: '柳浪闻莺公园' }, { city: '杭州' }).reviewedPoi, true);
});

test('provenance on save: signed user-guide kept, forged or renamed downgraded, legacy unknown', () => {
  const generated = deriveStopProvenance({ name: '法喜寺' }, { city: '杭州', guideText: '想去法喜寺' });
  assert.equal(normalizeStopProvenance({ provenance: generated }, '法喜寺', { city: '杭州' }).origin, 'user-guide');
  const forged = { origin: 'user-guide', name: '法喜寺', matchedText: '法喜寺', proof: 'deadbeef' };
  assert.equal(normalizeStopProvenance({ provenance: forged }, '法喜寺', { city: '杭州' }).origin, 'user-added');
  assert.equal(normalizeStopProvenance({ provenance: generated }, '灵隐寺', { city: '杭州' }).origin, 'user-added');
  assert.equal(normalizeStopProvenance({}, '法喜寺', { city: '杭州' }).origin, 'unknown');
  // imported-source is only kept while a server-signed source still mentions the stop.
  const claimed = { origin: 'imported-source', name: '茅家埠' };
  assert.equal(normalizeStopProvenance({ provenance: claimed }, '茅家埠', { city: '杭州', importedSources: [] }).origin, 'model');
});

test('model-written validations, metrics and logs are not kept', () => {
  const validations = buildRoutebookValidations(
    [stop('A'), stop('B')],
    [
      { id: 'crowd', label: '拥挤风险', state: '通过', detail: '模型说的' },
      { id: 'mode-123', label: '少走路重排', state: '已应用', detail: '用户操作' }
    ],
    '保存',
    { city: '杭州' }
  );
  assert.ok(!validations.some((item) => item.id === 'crowd'));
  assert.ok(validations.some((item) => item.id === 'mode-123'));
  assert.deepEqual(
    systemValidations([
      { id: 'walk', state: '通过' },
      { id: 'edit-hours', state: '未核验' }
    ]).map((item) => item.id),
    ['edit-hours']
  );
  assert.deepEqual(
    systemMetrics([
      { label: '站点均分', value: '88' },
      { label: '资料核验分', value: '40' }
    ]).map((item) => item.label),
    ['资料核验分']
  );

  const base = { city: '杭州', stops: [stop('法喜寺'), stop('茅家埠')] };
  const modelLogs = normalizeRoutebookForStorage({ ...base, logs: [{ stage: '可执行校验', status: '通过' }] });
  assert.deepEqual(modelLogs.logs, []);
  const forgedServerLogs = normalizeRoutebookForStorage({ ...base, logsSource: 'server', logs: [{ stage: '道路核验', status: '完成' }], logsProof: 'abc' });
  assert.deepEqual(forgedServerLogs.logs, []);
  const signed = serverProcessLogs([{ stage: '模型生成', result: '返回 2 个站点', status: '完成' }]);
  const kept = normalizeRoutebookForStorage({ ...base, ...signed });
  assert.equal(kept.logs.length, 1);
  assert.equal(kept.logs[0].stage, '模型生成');
});

test('old routebooks still normalize; stops get provenance and structured cost', () => {
  const legacy = normalizeRoutebookForStorage({
    city: '杭州',
    stops: [stop('法喜寺', { cost: '免费（需预约）', score: 95 }), stop('茅家埠', { cost: '门票 75 元 + 茶 50 元', score: 90 })],
    validations: [{ id: 'walk', label: '步行强度', state: '通过', detail: '模型' }],
    metrics: [{ label: '站点均分', value: '93' }]
  });
  assert.equal(legacy.stops[0].provenance.origin, 'unknown');
  assert.equal(legacy.stops[0].costInfo.free, true);
  assert.equal(legacy.stops[0].costInfo.reservationRequired, true);
  assert.equal(legacy.stops[1].costInfo.min, 125);
  assert.ok(!('score' in legacy.stops[0]));
  assert.ok(!legacy.validations.some((item) => item.id === 'walk'));
  assert.ok(!legacy.metrics.some((item) => item.label === '站点均分'));
  assert.ok(legacy.metrics.some((item) => item.label === '资料核验分'));
});

test('signed imported sources upgrade a stop on save', () => {
  const source = {
    url: 'https://example.com/a',
    platform: 'web',
    status: 'fetched',
    title: '茶园攻略',
    excerpt: '茅家埠很安静',
    trustScore: 60,
    fetchedAt: '2026-10-01T00:00:00.000Z'
  };
  const signed = { ...source, proof: signImportedSource(source) };
  const saved = normalizeRoutebookForStorage({ city: '杭州', stops: [stop('茅家埠'), stop('法喜寺')], importedSources: [signed] });
  assert.equal(saved.stops[0].provenance.origin, 'imported-source');
  assert.equal(saved.stops[1].provenance.origin, 'unknown');
});

test('F05: alias-aware must-go/avoid matching and explicit category words', () => {
  const stops = [stop('柳浪闻莺'), stop('龙井茶园')];
  const ok = buildConstraintValidation(stops, { mustGo: '柳浪闻莺公园、龙井茶园' }, '杭州');
  assert.equal(ok.state, '已纳入');
  const missing = buildConstraintValidation(stops, { mustGo: '灵隐寺' }, '杭州');
  assert.equal(missing.state, '未完全满足');
  const avoided = buildConstraintValidation(stops, { avoid: '柳浪闻莺公园' }, '杭州');
  assert.equal(avoided.state, '未完全满足');
  const category = buildConstraintValidation(stops, { avoid: '网红店、爬山' }, '杭州');
  assert.equal(category.state, '需人工确认');
  assert.match(category.detail, /类别词/);
});

test('public stop view exposes provenance/cost but never the model score or private guide quotes', async () => {
  const { publicRoutebookStop } = await import('../../server/routebooks/views.mjs');
  const view = publicRoutebookStop({
    id: 'a',
    name: '法喜寺',
    score: 97,
    cost: '免费（需预约）',
    costInfo: { free: true, reservationRequired: true, known: true, text: '免费（需预约）', items: [] },
    provenance: { origin: 'user-guide', matchedText: '我私下想去法喜寺', proof: 'sig', reviewedPoi: true, verifiedFactCount: 1 }
  });
  assert.equal(view.score, null);
  assert.deepEqual(view.provenance, { origin: 'user-guide', reviewedPoi: true, verifiedFactCount: 1 });
  assert.equal(view.costInfo.free, true);
  assert.equal(view.costInfo.reservationRequired, true);
  assert.equal(publicRoutebookStop({ provenance: { origin: 'evil' } }).provenance.origin, 'unknown');
});

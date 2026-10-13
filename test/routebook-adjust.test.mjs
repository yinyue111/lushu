import { isNavigableCoordinate } from '../src/lib/coordinates.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  stripModelSupplementStops,
  deleteDayStops,
  mergeDays,
  replaceStopWithPoi,
  applyPatchOps,
  setStopTransportMode
} from '../src/lib/routebookAdjust.js';
import { parseAdjustIntent } from '../src/lib/adjustIntents.js';

const stops = [
  { id: '1', name: 'A', day: 'Day 1', time: '10:00', provenance: { origin: 'user-guide' } },
  { id: '2', name: 'B', day: 'Day 1', time: '12:00', provenance: { origin: 'model' } },
  { id: '3', name: 'C', day: 'Day 2', time: '10:00', provenance: { origin: 'user-guide' } },
  { id: '4', name: 'D', day: 'Day 2', time: '14:00', provenance: { origin: 'model' } }
];

test('strip model supplements keeps guide anchors', () => {
  const result = stripModelSupplementStops(stops);
  assert.equal(result.removed, 2);
  assert.equal(result.stops.length, 2);
  assert.ok(result.stops.every((s) => s.provenance.origin === 'user-guide'));
});

test('delete day respects min stops', () => {
  const bad = deleteDayStops(stops.slice(0, 2), 'Day 1');
  assert.equal(bad.ok, false);
  const ok = deleteDayStops(stops, 'Day 2');
  assert.equal(ok.ok, true);
  assert.equal(ok.stops.length, 2);
});

test('merge days moves stops', () => {
  const result = mergeDays(stops, 'Day 2', 'Day 1');
  assert.equal(result.ok, true);
  assert.equal(result.moved, 2);
  assert.ok(result.stops.every((s) => s.day === 'Day 1'));
});

test('replace stop with poi', () => {
  const result = replaceStopWithPoi(stops, '2', { name: '新店', lat: 30.1, lng: 104.1, address: '地址' }, { city: '成都' });
  assert.equal(result.ok, true);
  assert.equal(result.stop.name, '新店');
  assert.equal(result.stop.provenance.origin, 'user-added');
});

test('set transport mode', () => {
  const result = setStopTransportMode(stops, '1', 'transit');
  assert.equal(result.ok, true);
  assert.equal(result.stops[0].transportMode, 'transit');
});

test('apply patch ops', () => {
  const { stops: next } = applyPatchOps(stops, [{ op: 'remove', stopId: '2' }]);
  assert.equal(next.length, 3);
});

test('parse intents', () => {
  const ctx = { days: ['Day 1', 'Day 2'], stopNames: ['宽窄巷子', '武侯祠'] };
  assert.equal(parseAdjustIntent('去掉路书补充站', ctx).kind, 'strip_model');
  assert.equal(parseAdjustIntent('少走路', ctx).params.mode, '少走路');
  assert.equal(parseAdjustIntent('删掉第二天', ctx).kind, 'delete_day');
  assert.equal(parseAdjustIntent('换成地铁优先', ctx).params.mode, 'transit');
  assert.equal(parseAdjustIntent('不要去宽窄巷子，换一家', ctx).kind, 'replace_stop');
  assert.equal(parseAdjustIntent('用 AI 重排 Day 1', ctx).level, 'L2');
  assert.equal(parseAdjustIntent('整本重新生成', ctx).level, 'L4');
});

test('replace stop does not carry old price/booking/risk/source', () => {
  const old = [
    { id: 'a', day: 'Day 1', time: '09:00', stay: '2小时', name: '灵隐寺', area: '西湖区', lat: 30.24, lng: 120.1, cost: '香花券 45 元', costInfo: { known: true, amount: 45, reservationRequired: true }, verify: '需提前预约', risk: '周末排队', reason: '古刹', tips: ['早去'], sourceEvidence: [{ url: 'https://x' }], provenance: { origin: 'guide' }, hours: '07:00-18:00' },
    { id: 'b', day: 'Day 1', time: '13:00', stay: '1小时', name: '茶馆', lat: 30.25, lng: 120.12 }
  ];
  const amap = replaceStopWithPoi(old, 'a', { name: '永福寺', lat: 30.245, lng: 120.105, address: '杭州', source: 'amap' }, { city: '杭州' }).stop;
  assert.equal(amap.cost, '价格待确认');
  assert.equal(amap.costInfo.known, false);
  assert.equal(amap.costInfo.reservationRequired, false);
  assert.ok(!/预约|排队/.test(amap.risk) && !/香花券/.test(JSON.stringify(amap)));
  assert.equal(amap.sourceEvidence, undefined);
  assert.equal(amap.reason, undefined);
  assert.equal(amap.tips, undefined);
  assert.equal(amap.hours, undefined);
  assert.equal(amap.provenance.origin, 'user-added');
  assert.equal(amap.navigationDisabled, false);
  assert.equal(amap.stay, '2小时');
  const unknown = replaceStopWithPoi(old, 'a', { name: '某小店', lat: 31.2, lng: 121.4, source: 'demo' }, { city: '杭州' }).stop;
  assert.equal(unknown.navigationDisabled, true);
  assert.equal(unknown.coordinatePrecision, 'approximate');
  assert.equal(unknown.lat, 30.24);
});

test('swapped stop: no old risk/guide source, and not navigable when the map did not find it', () => {
  const old = [{ id: 'a', day: 'Day 1', name: '灵隐寺', lat: 30.24, lng: 120.1, geoConfidence: 90, risk: '周末排队', verify: '需提前预约', poiId: 'poi-1', sourceEvidence: [{ url: 'x' }], provenance: { origin: 'user-guide', matchedText: '灵隐寺' }, guideSource: 'xhs' }];
  const found = replaceStopWithPoi(old, 'a', { name: '永福寺', lat: 30.245, lng: 120.105, source: 'amap' }).stop;
  const lost = replaceStopWithPoi(old, 'a', { name: '某小店', source: 'demo' }).stop;
  for (const s of [found, lost]) {
    assert.ok(!/排队|预约/.test(`${s.risk}${s.verify}`.replace('是否要预约', '')));
    assert.equal(s.poiId, undefined);
    assert.equal(s.guideSource, undefined);
    assert.equal(s.provenance.matchedText, undefined);
  }
  assert.equal(isNavigableCoordinate(found), true);
  assert.equal(isNavigableCoordinate(lost), false);
});

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

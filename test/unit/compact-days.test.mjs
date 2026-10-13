import test from 'node:test';
import assert from 'node:assert/strict';
import { compactDays, repairEmptyDays } from '../../src/lib/dayRepair.js';
import { deleteDayStops, mergeDays, applyPatchOps } from '../../src/lib/routebookAdjust.js';

const mk = (days) => days.map((day, i) => ({ id: `s${i + 1}`, name: `站${i + 1}`, day, time: `${10 + i}:00` }));

test('delete middle day: later days shift down, no stops added', () => {
  const stops = mk(['Day 1', 'Day 1', 'Day 2', 'Day 3', 'Day 3']);
  const del = deleteDayStops(stops, 'Day 2');
  const r = compactDays(del.stops, ['Day 1', 'Day 2', 'Day 3']);
  assert.deepEqual(r.days, ['Day 1', 'Day 2']);
  assert.deepEqual(r.stops.map((s) => [s.name, s.day]), [['站1', 'Day 1'], ['站2', 'Day 1'], ['站4', 'Day 2'], ['站5', 'Day 2']]);
  assert.deepEqual(r.removedDays, ['Day 2']);
  assert.match(r.validation.detail, /依次顺延/);
  assert.match(r.validation.detail, /没有为补满天数添加新站/);
});

test('merge Day 1 into Day 2: one day left, labelled Day 1', () => {
  const merged = mergeDays(mk(['Day 1', 'Day 1', 'Day 2', 'Day 2']), 'Day 1', 'Day 2');
  const r = compactDays(merged.stops, ['Day 1', 'Day 2']);
  assert.deepEqual(r.days, ['Day 1']);
  assert.equal(r.stops.length, 4);
  assert.ok(r.stops.every((s) => s.day === 'Day 1'));
});

test('L2 proposal removing all stops of a day compacts', () => {
  const stops = mk(['Day 1', 'Day 1', 'Day 2']);
  const applied = applyPatchOps(stops, [{ op: 'remove', stopId: 's3' }], { days: ['Day 1', 'Day 2'] });
  const r = compactDays(applied.stops, ['Day 1', 'Day 2']);
  assert.deepEqual(r.days, ['Day 1']);
  assert.equal(r.stops.length, 2);
});

test('no empty day: untouched, no note', () => {
  const stops = mk(['Day 1', 'Day 2']);
  const r = compactDays(stops, ['Day 1', 'Day 2']);
  assert.equal(r.stops, stops);
  assert.equal(r.validation, null);
});

test('custom day names are kept, only empty ones dropped', () => {
  const r = compactDays(mk(['周六', '周六']), ['周六', '周日']);
  assert.deepEqual(r.days, ['周六']);
  assert.equal(r.stops[0].day, '周六');
});

test('repairEmptyDays never grows the stop count', () => {
  const r = repairEmptyDays(mk(['Day 1', 'Day 1']), ['Day 1', 'Day 2', 'Day 3']);
  assert.equal(r.stops.length, 2);
  assert.deepEqual(r.days, ['Day 1', 'Day 2']);
});

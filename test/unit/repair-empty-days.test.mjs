import test from 'node:test';
import assert from 'node:assert/strict';
import { repairEmptyDays, dayPlanInstruction } from '../../server/ai/generate.mjs';

const mk = (days) => days.map((day, i) => ({ id: i + 1, name: `站${i + 1}`, day }));

test('all stops on Day 1 with 2 days chosen: redistributes existing stops in order, no new stops', () => {
  const r = repairEmptyDays(mk(['Day 1', 'Day 1', 'Day 1', 'Day 1', 'Day 1']), ['Day 1', 'Day 2']);
  assert.deepEqual(r.days, ['Day 1', 'Day 2']);
  assert.equal(r.stops.length, 5);
  assert.deepEqual(r.stops.map((s) => s.name), ['站1', '站2', '站3', '站4', '站5']);
  assert.deepEqual(r.stops.map((s) => s.day), ['Day 1', 'Day 1', 'Day 1', 'Day 2', 'Day 2']);
  assert.equal(r.validation.state, '已重新分配');
});

test('fewer stops than days: shrinks days instead of fabricating', () => {
  const r = repairEmptyDays(mk(['Day 1', 'Day 1', 'Day 1']), ['Day 1', 'Day 2', 'Day 3', 'Day 4']);
  assert.deepEqual(r.days, ['Day 1', 'Day 2', 'Day 3']);
  assert.equal(r.stops.length, 3);
  assert.equal(r.validation.state, '已缩短');
  assert.match(r.validation.detail, /没有为凑满 4 天编造新站/);
});

test('no empty day: untouched', () => {
  const stops = mk(['Day 1', 'Day 2', 'Day 2']);
  const r = repairEmptyDays(stops, ['Day 1', 'Day 2']);
  assert.equal(r.stops, stops);
  assert.equal(r.validation, null);
});

test('prompt states exact day count', () => {
  assert.match(dayPlanInstruction('3 天 2 晚'), /恰好是 \[Day 1、Day 2、Day 3\]/);
  assert.match(dayPlanInstruction(''), /2 天/);
});

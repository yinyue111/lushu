import test from 'node:test';
import assert from 'node:assert/strict';
import { retimeReorderedDays } from '../../src/lib/stopTiming.js';

test('moving a later stop up hands it the earlier slot and keeps its own duration', () => {
  const stops = [
    { id: 'a', day: 'Day 1', time: '14:20-15:50' },
    { id: 'kxl', day: 'Day 1', time: '18:10-19:50' },
    { id: 'kz', day: 'Day 1', time: '16:20-17:50' },
    { id: 'd2', day: 'Day 2', time: '09:00-11:20' }
  ];
  const next = retimeReorderedDays(stops, ['Day 1']);
  assert.deepEqual(
    next.map((stop) => stop.time),
    ['14:20-15:50', '16:20-18:00', '18:10-19:40', '09:00-11:20']
  );
  assert.equal(next[0], stops[0], 'unchanged stops keep identity');
});

test('a slot never starts before the previous stop ends', () => {
  const next = retimeReorderedDays(
    [
      { day: 'Day 1', time: '10:30-12:30' },
      { day: 'Day 1', time: '09:00-09:30' }
    ],
    ['Day 1']
  );
  assert.deepEqual(
    next.map((stop) => stop.time),
    ['09:00-11:00', '11:00-11:30']
  );
});

test('unparseable times are left alone instead of inventing a schedule', () => {
  const stops = [
    { day: 'Day 1', time: '上午' },
    { day: 'Day 1', time: '09:00-10:00' }
  ];
  assert.deepEqual(retimeReorderedDays(stops, ['Day 1']), stops);
});

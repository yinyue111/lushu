import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeRoutebookForStorage } from '../../server/routebooks/normalize.mjs';

const stop = (name, day) => ({ name, day, time: '10:00', lat: 30.24, lng: 120.16 });

test('saving drops days that have no stops (old 第N天0站 data), keeps order', () => {
  const saved = normalizeRoutebookForStorage({ city: '杭州', days: ['Day 1', 'Day 2', 'Day 3'], stops: [stop('法喜寺', 'Day 1'), stop('茅家埠', 'Day 3')] });
  assert.deepEqual(saved.days, ['Day 1', 'Day 3']);
  assert.equal(saved.stops.length, 2);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { preserveUnaffectedRouteLegs } from '../../src/lib/routeLegEdits.js';

const stop = (id, lat, extra = {}) => ({ id, lat, lng: 120, day: 'Day 1', ...extra });
const leg = (from, to) => ({ fromStopId: from, toStopId: to, status: 'verified', proof: 'p' });

test('F12: an edit only invalidates the legs it touches', () => {
  const before = [stop('a', 30.1), stop('b', 30.2), stop('c', 30.3), stop('d', 30.4)];
  const legs = [leg('a', 'b'), leg('b', 'c'), leg('c', 'd')];
  // Move c's coordinates: legs b→c and c→d are affected, a→b stays.
  const moved = before.map((item) => (item.id === 'c' ? { ...item, lat: 30.35 } : item));
  assert.deepEqual(
    preserveUnaffectedRouteLegs(before, moved, legs).map((item) => `${item.fromStopId}${item.toStopId}`),
    ['ab']
  );
  // Delete b: a→b and b→c disappear; c→d stays.
  const removed = before.filter((item) => item.id !== 'b');
  assert.deepEqual(
    preserveUnaffectedRouteLegs(before, removed, legs).map((item) => `${item.fromStopId}${item.toStopId}`),
    ['cd']
  );
  // Changing transport mode of d invalidates c→d.
  const mode = before.map((item) => (item.id === 'd' ? { ...item, transportMode: 'driving' } : item));
  assert.equal(preserveUnaffectedRouteLegs(before, mode, legs).length, 2);
  // Moving a stop to another day breaks adjacency.
  const split = before.map((item) => (item.id === 'c' || item.id === 'd' ? { ...item, day: 'Day 2' } : item));
  assert.equal(preserveUnaffectedRouteLegs(before, split, legs).length, 1);
  assert.deepEqual(preserveUnaffectedRouteLegs(before, before, []), []);
});

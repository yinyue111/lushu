import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listTripSessions } from '../../src/lib/tripSession.js';

/** @returns {any} */
function memoryStorage(entries) {
  const map = new Map(Object.entries(entries));
  return {
    get length() {
      return map.size;
    },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => map.get(key) ?? null
  };
}

test('F15: export includes every trip session of the profile and skips corrupt ones', () => {
  const storage = memoryStorage({
    'trusted-routebook:trip-session:v1:p_me:route%201': JSON.stringify({ currentIndex: 2, startedAt: '2026-10-01' }),
    'trusted-routebook:trip-session:v1:p_me:route-2': '{bad json',
    'trusted-routebook:trip-session:v1:p_other:route-3': JSON.stringify({ currentIndex: 1 }),
    unrelated: '1'
  });
  assert.deepEqual(listTripSessions('p_me', storage), [{ routeId: 'route 1', currentIndex: 2, startedAt: '2026-10-01' }]);
  assert.deepEqual(listTripSessions('p_me', undefined), []);
});

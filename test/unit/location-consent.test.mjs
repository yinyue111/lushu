import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LOCATION_CONSENT_KEY,
  grantLocationConsent,
  hasLocationConsent,
  requestPositionWithConsent,
  withdrawLocationConsent
} from '../../src/lib/locationConsent.js';

function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
}

test('geolocation is never called before consent, and stops again after withdrawal', () => {
  const storage = memoryStorage();
  let calls = 0;
  const geolocation = { getCurrentPosition: () => (calls += 1) };
  const request = () => requestPositionWithConsent({ storage, geolocation, onPosition: () => {}, onError: () => {} });
  assert.equal(request(), 'needs-consent');
  assert.equal(calls, 0);
  grantLocationConsent(storage, () => new Date('2026-10-09T00:00:00Z'));
  assert.equal(hasLocationConsent(storage), true);
  assert.equal(request(), 'requested');
  assert.equal(calls, 1);
  withdrawLocationConsent(storage);
  assert.equal(request(), 'needs-consent');
  assert.equal(calls, 1);
});

test('consent for an older policy version or corrupt data does not count', () => {
  const storage = memoryStorage();
  storage.setItem(LOCATION_CONSENT_KEY, JSON.stringify({ granted: true, policyVersion: 'old' }));
  assert.equal(hasLocationConsent(storage), false);
  storage.setItem(LOCATION_CONSENT_KEY, '{oops');
  assert.equal(hasLocationConsent(storage), false);
  grantLocationConsent(storage);
  assert.equal(requestPositionWithConsent({ storage, geolocation: null, onPosition: () => {}, onError: () => {} }), 'unsupported');
});

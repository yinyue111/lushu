import assert from 'node:assert/strict';
import { test } from 'node:test';
import { grantProfileCloudRegistrationConsent, parseProfileSyncCode, prepareProfileSyncPayload } from '../../src/lib/profile.js';
import { readTripSession, restoreTripSession, saveTripSession } from '../../src/lib/tripSession.js';

const values = new Map();
globalThis.localStorage = {
  get length() {
    return values.size;
  },
  clear: () => values.clear(),
  key: (index) => [...values.keys()][index] ?? null,
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => {
    values.set(key, value);
  },
  removeItem: (key) => {
    values.delete(key);
  }
};

test('cloud registration is explicit and persists the same retry credential', () => {
  const local = { id: 'p_local_consent_fixture' };
  assert.throws(() => prepareProfileSyncPayload(local), { code: 'PROFILE_CLOUD_REGISTRATION_CONSENT_REQUIRED' });
  const consented = grantProfileCloudRegistrationConsent(local);
  const first = prepareProfileSyncPayload(consented);
  assert.match(first.pendingRegistrationSecret, /^preg_[A-Za-z0-9_-]{43}$/);
  assert.equal(prepareProfileSyncPayload(consented).pendingRegistrationSecret, first.pendingRegistrationSecret);
});

test('v2 recovery parsing does not need or create an access token', () => {
  const payload = {
    version: 2,
    profileId: 'p_recovery_fixture',
    nonce: 'x'.repeat(20),
    proof: 'a'.repeat(64),
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  };
  const parsed = parseProfileSyncCode(`trb1_${Buffer.from(JSON.stringify(payload)).toString('base64url')}`);
  assert.equal(parsed.profileId, payload.profileId);
  assert.equal(parsed.profileAccessToken, undefined);
  assert.equal(parsed.recoveryProof, payload.proof);
});

test('trip restoration preserves cloud timestamps and local edits increment sequence', () => {
  const route = { id: 'route-session-test', stops: [{ id: 'one', name: 'One' }] };
  const profileId = 'p_session_test';
  const snapshot = { stops: route.stops, revision: 3, cloudRevision: 3, pendingSync: false, updatedAt: '2026-01-01T00:00:00.000Z' };
  assert.equal(restoreTripSession(route, profileId, snapshot), true);
  assert.equal(readTripSession(route, profileId).updatedAt, snapshot.updatedAt);
  saveTripSession(route, profileId, { stops: route.stops, pendingSync: true });
  const first = readTripSession(route, profileId);
  saveTripSession(route, profileId, { stops: route.stops, pendingSync: true });
  const second = readTripSession(route, profileId);
  assert.equal(second.localRevision, first.localRevision + 1);
  assert.equal(second.cloudRevision, 3);
});

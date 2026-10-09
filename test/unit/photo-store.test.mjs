import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deleteCheckinPhoto, loadCheckinPhoto, photoStoreAvailable, setPhotoBackendForTests, stashCheckinPhoto } from '../../src/lib/photoStore.js';

const DATA_URL = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';

test('F09: queued photos round-trip through the IndexedDB backend as Blobs', async () => {
  const map = new Map();
  setPhotoBackendForTests({ put: async (id, value) => void map.set(id, value), get: async (id) => map.get(id), delete: async (id) => void map.delete(id) });
  assert.equal(photoStoreAvailable(), true);
  assert.equal(await stashCheckinPhoto('local-1', DATA_URL), true);
  assert.ok(map.get('local-1') instanceof Blob, 'stored as a Blob, not a data URL string');
  assert.equal(await loadCheckinPhoto('local-1'), DATA_URL);
  await deleteCheckinPhoto('local-1');
  assert.equal(await loadCheckinPhoto('local-1'), '', 'a missing photo loads as empty so the check-in still syncs');
});

test('F09: without IndexedDB the caller falls back to inlining', async () => {
  setPhotoBackendForTests(null);
  assert.equal(photoStoreAvailable(), false);
  assert.equal(await stashCheckinPhoto('local-2', DATA_URL), false);
  assert.equal(await loadCheckinPhoto('local-2'), '');
  const failing = { put: async () => Promise.reject(new Error('QuotaExceeded')), get: async () => undefined, delete: async () => {} };
  setPhotoBackendForTests(failing);
  assert.equal(await stashCheckinPhoto('local-3', DATA_URL), false);
  setPhotoBackendForTests(undefined);
});

test('F09: stashing never fetches the data URL (blocked by the production CSP connect-src)', async () => {
  const map = new Map();
  setPhotoBackendForTests({ put: async (id, value) => void map.set(id, value), get: async (id) => map.get(id), delete: async (id) => void map.delete(id) });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError('Refused to connect: CSP connect-src');
  };
  try {
    assert.equal(await stashCheckinPhoto('local-csp', DATA_URL), true);
    const blob = map.get('local-csp');
    assert.ok(blob instanceof Blob);
    assert.equal(blob.type, 'image/jpeg');
    assert.equal(await loadCheckinPhoto('local-csp'), DATA_URL, 'bytes survive the round trip');
    assert.equal(await stashCheckinPhoto('local-bad', 'not-a-data-url'), false);
  } finally {
    globalThis.fetch = originalFetch;
    setPhotoBackendForTests(undefined);
  }
});

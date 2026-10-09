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

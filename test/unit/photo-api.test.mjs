import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchCheckinPhoto } from '../../src/lib/photoApi.js';

function memoryStorage() {
  const values = new Map();
  return {
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
}

test('photo requests send credentials only for the requested access mode, never in URLs', async (t) => {
  const originals = { fetch: globalThis.fetch, localStorage: globalThis.localStorage, sessionStorage: globalThis.sessionStorage };
  t.after(() => {
    Object.assign(globalThis, originals);
  });
  globalThis.localStorage = memoryStorage();
  globalThis.sessionStorage = memoryStorage();
  localStorage.setItem('trusted-routebook:profile:v1', JSON.stringify({ id: 'p_photo_fixture', profileAccessToken: 'pt_photo_owner_token_fixture' }));
  sessionStorage.setItem('trusted-routebook:admin-token', 'test-photo-admin');
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(new Blob(['photo'], { type: 'image/png' }), { status: 200 });
  };
  const publicBlob = await fetchCheckinPhoto('photo_fixture');
  assert.equal(publicBlob.type, 'image/png');
  assert.deepEqual(calls[0].options.headers, {}, 'anonymous public display must not send locally saved privileged credentials');
  await fetchCheckinPhoto('photo_fixture', { profileId: 'p_photo_fixture', access: 'owner' });
  assert.equal(calls[1].options.headers['x-routebook-profile-id'], 'p_photo_fixture');
  assert.equal(calls[1].options.headers['x-routebook-profile-token'], 'pt_photo_owner_token_fixture');
  await fetchCheckinPhoto('photo_fixture', { access: 'admin' });
  assert.deepEqual(calls[2].options.headers, { 'x-routebook-admin-token': 'test-photo-admin' });
  for (const call of calls) {
    assert.equal(call.url, '/api/checkin-photos/photo_fixture');
    assert.equal(call.options.cache, 'no-store');
  }
  await assert.rejects(fetchCheckinPhoto('../private'), /照片标识无效/);
  assert.equal(calls.length, 3);
  globalThis.fetch = async () => new Response(JSON.stringify({ error: '照片不存在', code: 'PHOTO_NOT_FOUND' }), { status: 404 });
  await assert.rejects(fetchCheckinPhoto('photo_fixture'), { status: 404, code: 'PHOTO_NOT_FOUND' });
  globalThis.fetch = async () => new Response('<html>not a photo</html>', { headers: { 'content-type': 'text/html' } });
  await assert.rejects(fetchCheckinPhoto('photo_fixture'), /照片响应格式不正确/);
});

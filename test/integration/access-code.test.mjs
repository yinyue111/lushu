import assert from 'node:assert/strict';
import { test } from 'node:test';
import { API_TOKEN, fetchJson, jsonHeaders, startServer } from '../helpers/server.mjs';

const post = (server, headers = {}) =>
  fetchJson(`${server.baseUrl}/api/import-guide`, { method: 'POST', headers: jsonHeaders(headers), body: JSON.stringify({ urls: ['https://example.com/a'] }) });

test('a configured access code gets plain, specific 403 codes', async (t) => {
  const server = await startServer();
  t.after(server.stop);
  const missing = await post(server);
  assert.equal(missing.status, 403);
  assert.equal(missing.data.code, 'ACCESS_CODE_REQUIRED');
  assert.match(missing.data.error, /访问码.*高级设置/);
  const wrong = await post(server, { 'x-routebook-token': `${API_TOKEN}-wrong` });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.data.code, 'ACCESS_CODE_INVALID');
  const right = await post(server, { 'x-routebook-token': API_TOKEN });
  assert.notEqual(right.status, 403, JSON.stringify(right.data));
});

test('LOCAL_ONLY stays for deployments without any access code', async (t) => {
  const server = await startServer({ env: { ROUTEBOOK_API_TOKEN: null, ALLOW_PUBLIC_MODEL_PROXY: null, PROFILE_ID_SECRET: 'unit-test-profile-secret' } });
  t.after(server.stop);
  const denied = await post(server, { 'x-routebook-token': 'anything' });
  assert.equal(denied.status, 403);
  assert.equal(denied.data.code, 'LOCAL_ONLY');
  assert.doesNotMatch(denied.data.error, /令牌|本机/);
});

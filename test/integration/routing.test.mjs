import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { adminHeaders, fetchJson, jsonHeaders, startServer, writeJsonl } from '../helpers/server.mjs';

// M5 regression: prefix routing + sanitizePublicId used to map `/api/routebooks/rb/-hz`
// (and `/api/share/rb/-hz`) onto the routebook `rb-hz`.

const stops = [
  { id: 's1', name: '断桥残雪', lat: 30.2588, lng: 120.1525 },
  { id: 's2', name: '平湖秋月', lat: 30.2525, lng: 120.1441 }
];

let server;
before(async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'routebook-routing-'));
  await writeJsonl(dataDir, 'routebooks.jsonl', [
    { id: 'rb-hz', publicId: 'rb-hz', title: '西湖', city: '杭州', publishStatus: 'published', version: 1, stops }
  ]);
  server = await startServer({ dataDir });
});
after(async () => {
  await server?.stop();
});

test('single-segment ids still resolve', async () => {
  const detail = await fetchJson(`${server.baseUrl}/api/routebooks/rb-hz`);
  assert.equal(detail.status, 200, JSON.stringify(detail.data));
  const share = await fetchJson(`${server.baseUrl}/api/share/rb-hz`);
  assert.equal(share.status, 200, JSON.stringify(share.data));
});

test('a path separator inside the id no longer aliases another routebook', async () => {
  for (const path of ['/api/routebooks/rb/-hz', '/api/share/rb/-hz', '/api/routebooks/rb-hz/unknown']) {
    const result = await fetchJson(`${server.baseUrl}${path}`);
    assert.equal(result.status, 404, path);
    assert.equal(result.data.code, 'API_NOT_FOUND', path);
  }
});

test('sub-resources and both poi-correction status URLs are routed', async () => {
  const versions = await fetchJson(`${server.baseUrl}/api/routebooks/rb-hz/versions`, { headers: adminHeaders() });
  assert.equal(versions.status, 200, JSON.stringify(versions.data));
  for (const path of ['/api/poi-corrections/missing/status', '/api/poi-corrections/missing']) {
    const result = await fetchJson(`${server.baseUrl}${path}`, {
      method: 'POST',
      headers: { ...jsonHeaders(), ...adminHeaders() },
      body: JSON.stringify({ action: 'approved' })
    });
    assert.equal(result.status, 404, path);
    assert.equal(result.data.code, 'CORRECTION_NOT_FOUND', path);
  }
});

test('unknown API paths return API_NOT_FOUND with a request id', async () => {
  const result = await fetchJson(`${server.baseUrl}/api/does-not-exist`);
  assert.equal(result.status, 404);
  assert.equal(result.data.code, 'API_NOT_FOUND');
  assert.ok(result.data.requestId);
});

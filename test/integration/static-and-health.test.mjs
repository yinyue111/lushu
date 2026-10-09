import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { after, before, test } from 'node:test';
import { API_TOKEN, adminHeaders, fetchJson, startServer } from '../helpers/server.mjs';

const DIST = join(process.cwd(), 'dist');
const hasDist = existsSync(join(DIST, 'index.html'));

function rawGet(baseUrl, path, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = request(new URL(path, baseUrl), { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

let server;
before(async () => {
  server = await startServer();
});
after(async () => {
  await server?.stop();
});

test('L5: production /api/health hides provider details from anonymous callers', async () => {
  const anonymous = await fetchJson(`${server.baseUrl}/api/health`, { headers: { 'x-routebook-token': API_TOKEN } });
  assert.equal(anonymous.status, 200);
  assert.equal(anonymous.data.ready, true);
  assert.equal(anonymous.data.access, 'open');
  for (const key of ['provider', 'model', 'wireApi', 'baseUrl', 'geocoder']) assert.equal(anonymous.data[key], undefined, key);
  const admin = await fetchJson(`${server.baseUrl}/api/health`, { headers: adminHeaders() });
  assert.equal(admin.data.model, 'test-fake-model');
  assert.ok('baseUrl' in admin.data);
});

test('L8: index.html keeps CSP + no-cache and supports ETag/304 and HEAD', { skip: !hasDist && 'dist/ not built' }, async () => {
  const plain = await rawGet(server.baseUrl, '/', { 'accept-encoding': 'gzip, br' });
  assert.equal(plain.status, 200);
  assert.equal(plain.headers['cache-control'], 'no-cache');
  assert.match(plain.headers['content-security-policy'] ?? '', /default-src 'self'/);
  assert.ok(plain.headers.etag);
  const notModified = await rawGet(server.baseUrl, '/', { 'if-none-match': plain.headers.etag });
  assert.equal(notModified.status, 304);
  assert.equal(notModified.body.length, 0);
  const head = await rawGet(server.baseUrl, '/', {}, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
});

test('L8: compressible assets are served as br/gzip according to Accept-Encoding', { skip: !hasDist && 'dist/ not built' }, async () => {
  const asset = readdirSync(join(DIST, 'assets')).find((name) => /^index-[A-Za-z0-9_-]{8}\.js$/.test(name));
  const path = `/assets/${asset}`;
  const plain = await rawGet(server.baseUrl, path);
  assert.equal(plain.headers['content-encoding'], undefined);
  const br = await rawGet(server.baseUrl, path, { 'accept-encoding': 'gzip, deflate, br' });
  assert.equal(br.headers['content-encoding'], 'br');
  assert.equal(br.headers.vary, 'accept-encoding');
  assert.ok(br.body.length < plain.body.length / 2);
  assert.deepEqual(brotliDecompressSync(br.body), plain.body);
  const gz = await rawGet(server.baseUrl, path, { 'accept-encoding': 'gzip, br;q=0' });
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.deepEqual(gunzipSync(gz.body), plain.body);
});

test('L8: hashed assets are immutable; SPA fallback and 404s are unchanged', { skip: !hasDist && 'dist/ not built' }, async () => {
  const asset = readdirSync(join(DIST, 'assets')).find((name) => /^index-[A-Za-z0-9_-]{8}\.js$/.test(name));
  assert.ok(asset, 'hashed index bundle');
  const js = await rawGet(server.baseUrl, `/assets/${asset}`, { 'accept-encoding': 'gzip' });
  assert.equal(js.status, 200);
  assert.equal(js.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.equal(js.headers['content-encoding'], 'gzip');
  const spa = await rawGet(server.baseUrl, '/trip/some-route');
  assert.equal(spa.status, 200);
  assert.match(spa.headers['content-type'], /text\/html/);
  for (const path of ['/assets/missing-file.js', '/assets', '/%2e%2e/package.json']) {
    const missing = await rawGet(server.baseUrl, path);
    assert.equal(missing.status, 404, path);
  }
});

test('map tiles: /api/map-tiles/config describes the basemap without keys; bad paths are rejected', async () => {
  const config = await fetchJson(`${server.baseUrl}/api/map-tiles/config`);
  assert.equal(config.status, 200);
  assert.equal(config.data.provider, 'osm-de');
  assert.equal(config.data.coordinateSystem, 'wgs84');
  assert.equal(config.data.labels, false);
  const labels = await rawGet(server.baseUrl, '/api/map-tiles/labels/3/1/2.png');
  assert.equal(labels.status, 404);
  const bad = await rawGet(server.baseUrl, '/api/map-tiles/30/1/2.png');
  assert.equal(bad.status, 400);
});

test('/api/health "ready" reflects whether this caller can generate (access code), not just the model', async (t) => {
  const noCode = await fetchJson(`${server.baseUrl}/api/health`);
  assert.equal(noCode.data.ready, false, 'production without the access code is not ready');
  assert.equal(noCode.data.modelReady, true);
  assert.equal(noCode.data.access, 'needs-access-code');
  assert.match(noCode.data.reason, /访问码/);
  const wrongCode = await fetchJson(`${server.baseUrl}/api/health`, { headers: { 'x-routebook-token': 'wrong' } });
  assert.equal(wrongCode.data.access, 'needs-access-code');
  const closed = await startServer({ env: { ALLOW_PUBLIC_MODEL_PROXY: 'false' } });
  t.after(closed.stop);
  const disabled = await fetchJson(`${closed.baseUrl}/api/health`, { headers: { 'x-routebook-token': API_TOKEN } });
  assert.equal(disabled.data.ready, false);
  assert.equal(disabled.data.access, 'disabled');
  const local = await startServer({ env: { ALLOW_LOCAL_API_BYPASS: 'true' } });
  t.after(local.stop);
  const bypass = await fetchJson(`${local.baseUrl}/api/health`);
  assert.equal(bypass.data.ready, true);
  assert.equal(bypass.data.access, 'open');
});

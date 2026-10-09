import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { adminHeaders, fetchJson, startServer, writeJsonl } from '../helpers/server.mjs';

let server;
let dataDir;

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'lushu-ops-review-queue-'));
  await writeJsonl(dataDir, 'poi-corrections.jsonl', [
    { id: 'correction-old', city: '杭州', stopName: '旧地点', status: 'pending', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'correction-middle', city: '上海', stopName: '中间地点', status: 'pending', createdAt: '2026-01-02T00:00:00.000Z' },
    { id: 'correction-new', city: '杭州', stopName: '新地点', status: 'pending', createdAt: '2026-01-03T00:00:00.000Z' },
    { id: 'correction-approved', city: '杭州', stopName: '已处理地点', status: 'pending', createdAt: '2026-01-04T00:00:00.000Z' },
    {
      id: 'correction-approved',
      city: '杭州',
      stopName: '已处理地点',
      status: 'approved',
      reviewedAt: '2026-01-05T00:00:00.000Z',
      createdAt: '2026-01-04T00:00:00.000Z'
    }
  ]);
  server = await startServer({ dataDir });
});

after(async () => {
  await server?.stop();
  await rm(dataDir, { recursive: true, force: true });
});

test('review queue filters latest status before cursor pagination and returns total', async () => {
  const unauthorized = await fetchJson(`${server.baseUrl}/api/ops/review-queue?status=pending`);
  assert.equal(unauthorized.status, 403);

  const first = await fetchJson(`${server.baseUrl}/api/ops/review-queue?status=pending&limit=2`, { headers: adminHeaders() });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.total, 3);
  assert.equal(first.data.corrections.length, 2);
  assert.deepEqual(
    first.data.corrections.map((row) => row.id),
    ['correction-new', 'correction-middle']
  );
  assert.ok(first.data.nextCursor);

  const second = await fetchJson(`${server.baseUrl}/api/ops/review-queue?status=pending&limit=2&cursor=${encodeURIComponent(first.data.nextCursor)}`, {
    headers: adminHeaders()
  });
  assert.equal(second.status, 200, JSON.stringify(second.data));
  assert.equal(second.data.total, 3);
  assert.deepEqual(
    second.data.corrections.map((row) => row.id),
    ['correction-old']
  );
  assert.equal(second.data.nextCursor, '');

  const approved = await fetchJson(`${server.baseUrl}/api/ops/review-queue?status=approved`, { headers: adminHeaders() });
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  assert.equal(approved.data.total, 1);
  assert.equal(approved.data.corrections[0].id, 'correction-approved');

  const invalidCursor = await fetchJson(`${server.baseUrl}/api/ops/review-queue?cursor=not-a-cursor`, { headers: adminHeaders() });
  assert.equal(invalidCursor.status, 400);
  assert.equal(invalidCursor.data.code, 'INVALID_REVIEW_CURSOR');
});

test('explicitly saving an empty product list stays empty instead of restoring seed cards', async () => {
  const saved = await fetchJson(`${server.baseUrl}/api/products`, {
    method: 'POST',
    headers: { ...adminHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ products: [] })
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.deepEqual(saved.data.products, []);

  const readBack = await fetchJson(`${server.baseUrl}/api/products`);
  assert.equal(readBack.status, 200, JSON.stringify(readBack.data));
  assert.deepEqual(readBack.data.products, []);
});

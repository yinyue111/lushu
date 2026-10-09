import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { adminHeaders, fetchJson, startServer, writeJsonl } from '../helpers/server.mjs';

// F17: check-in review and routebook versions page on the server instead of
// taking a fixed latest-200 / latest-120 window.

const iso = (index) => new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
let server;
before(async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'routebook-f17-'));
  const checkins = [];
  for (let index = 0; index < 260; index += 1) {
    checkins.push({
      id: `ck-${String(index).padStart(3, '0')}`,
      routeId: 'rb-1',
      stopId: 'a',
      createdAt: iso(index),
      status: index % 10 === 0 ? 'skipped' : 'arrived',
      arrival: { valid: index % 2 === 0, confidence: index % 2 === 0 ? 'valid' : 'weak' }
    });
  }
  await writeJsonl(dataDir, 'checkins.jsonl', checkins);
  const routebooks = [];
  for (let index = 0; index < 130; index += 1) {
    routebooks.push({ id: `rb-${index}`, publicId: `rb-${index}`, title: `路书 ${index}`, city: '杭州', version: 1, stops: [], updatedAt: iso(index) });
  }
  await writeJsonl(dataDir, 'routebooks.jsonl', routebooks);
  server = await startServer({ dataDir });
});
after(async () => {
  await server?.stop();
});

async function collect(path, key) {
  const seen = [];
  let cursor = '';
  let pages = 0;
  do {
    const result = await fetchJson(`${server.baseUrl}${path}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { headers: adminHeaders() });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    seen.push(...result.data[key]);
    cursor = result.data.nextCursor;
    pages += 1;
    assert.ok(pages < 20, 'paging must terminate');
  } while (cursor);
  return { seen, pages };
}

test('ops check-ins: every row reachable, newest first, no duplicates', async () => {
  const { seen, pages } = await collect('/api/ops/checkins?limit=100', 'checkins');
  assert.equal(pages, 3);
  assert.equal(seen.length, 260);
  assert.equal(new Set(seen.map((row) => row.id)).size, 260);
  assert.equal(seen[0].id, 'ck-259');
  assert.equal(seen.at(-1).id, 'ck-000');
});

test('ops check-ins: filters run on the server before paging', async () => {
  const weak = await collect('/api/ops/checkins?limit=50&filter=weak', 'checkins');
  assert.equal(weak.seen.length, 130);
  assert.ok(weak.seen.every((row) => row.arrival.confidence === 'weak'));
  const skipped = await fetchJson(`${server.baseUrl}/api/ops/checkins?limit=200&filter=skipped`, { headers: adminHeaders() });
  assert.equal(skipped.data.total, 26);
  const bad = await fetchJson(`${server.baseUrl}/api/ops/checkins?filter=nope`, { headers: adminHeaders() });
  assert.equal(bad.status, 400);
  const badCursor = await fetchJson(`${server.baseUrl}/api/ops/checkins?cursor=%%%`, { headers: adminHeaders() });
  assert.equal(badCursor.status, 400);
});

test('routebook listing pages past the old 120 window', async () => {
  const { seen } = await collect('/api/routebooks?limit=50', 'routebooks');
  assert.equal(seen.length, 130);
  assert.equal(new Set(seen.map((row) => row.publicId)).size, 130);
  assert.equal(seen[0].publicId, 'rb-129');
});

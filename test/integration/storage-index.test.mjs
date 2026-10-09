import assert from 'node:assert/strict';
import { appendFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { adminHeaders, fetchJson, jsonHeaders, startServer, writeJsonl } from '../helpers/server.mjs';

// H5: latest-by-id lookups go through an in-memory offset index and history
// readers use slim projections; results must match the old full-scan semantics.

const stops = [
  { id: 's1', name: '断桥残雪', lat: 30.2588, lng: 120.1525 },
  { id: 's2', name: '平湖秋月', lat: 30.2525, lng: 120.1441 }
];
const route = (id, extra = {}) => ({
  id,
  publicId: id,
  title: `路书 ${id}`,
  city: '杭州',
  publishStatus: 'published',
  version: 1,
  stops,
  ...extra
});

let server;
before(async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'routebook-h5-'));
  const rows = [route('rb-oldest', { title: '最早的路书', provider: { editedAt: '2026-01-01T00:00:00.000Z' } })];
  for (let index = 0; index < 3000; index += 1) rows.push(route(`rb-filler-${index}`));
  rows.push(route('rb-oldest', { version: 2, title: '最早的路书 v2', changeReason: '编辑' }));
  await writeJsonl(dataDir, 'routebooks.jsonl', rows);
  server = await startServer({ dataDir });
});
after(async () => {
  await server?.stop();
});

test('an old routebook behind thousands of newer rows resolves to its latest snapshot', async () => {
  const result = await fetchJson(`${server.baseUrl}/api/routebooks/rb-oldest`);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.routebook.title, '最早的路书 v2');
});

test('writes through the API are visible on the next read (read-your-writes)', async () => {
  const update = await fetchJson(`${server.baseUrl}/api/routebooks/rb-oldest/status`, {
    method: 'POST',
    headers: { ...jsonHeaders(), ...adminHeaders() },
    body: JSON.stringify({ publishStatus: 'archived', expectedVersion: 2, opsNote: '索引回归归档' })
  });
  assert.equal(update.status, 200, JSON.stringify(update.data));
  assert.equal(update.data.routebook.version, 3);
  const publicRead = await fetchJson(`${server.baseUrl}/api/routebooks/rb-oldest`);
  assert.equal(publicRead.status, 404);
  const adminRead = await fetchJson(`${server.baseUrl}/api/routebooks/rb-oldest`, { headers: adminHeaders() });
  assert.equal(adminRead.status, 200);
  assert.equal(adminRead.data.routebook.publishStatus, 'archived');
});

test('version history and audits are built from projected rows', async () => {
  const result = await fetchJson(`${server.baseUrl}/api/routebooks/rb-oldest/versions`, { headers: adminHeaders() });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.deepEqual(
    result.data.versions.map((item) => item.version),
    [1, 2, 3]
  );
  assert.equal(result.data.versions[1].changeReason, '编辑');
  assert.equal(result.data.versions[2].publishStatus, 'archived');
  assert.equal(result.data.currentVersion, 3);
  assert.ok(
    result.data.audits.some((audit) => audit.event === 'status-changed'),
    JSON.stringify(result.data.audits)
  );
});

test('rows appended by another process are picked up without a restart', async () => {
  await appendFile(join(server.dataDir, 'routebooks.jsonl'), `${JSON.stringify(route('rb-external', { title: '外部写入' }))}\n`);
  const result = await fetchJson(`${server.baseUrl}/api/routebooks/rb-external`);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.routebook.title, '外部写入');
});

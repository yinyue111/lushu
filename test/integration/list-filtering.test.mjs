import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { adminHeaders, fetchJson, startServer, writeJsonl } from '../helpers/server.mjs';

// H4 regression: list endpoints used to take the global latest-N window first and
// filter afterwards, so matching rows outside the window silently disappeared.

const route = (id, city, extra = {}) => ({
  id,
  publicId: id,
  title: `路书 ${id}`,
  city,
  publishStatus: 'published',
  version: 1,
  stops: [],
  ...extra
});

let server;
before(async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'routebook-h4-'));
  const rows = [
    route('rb-hz-old', '杭州', { profileId: 'p_owner', creator: { id: 'creator-a', name: 'A' } }),
    route('rb-hz-archived', '杭州'),
    route('rb-hz-archived', '杭州', { version: 2, publishStatus: 'archived' })
  ];
  for (let index = 0; index < 520; index += 1) {
    rows.push(route(`rb-sh-${index}`, '上海', { creator: { id: 'creator-b', name: 'B' } }));
  }
  await writeJsonl(dataDir, 'routebooks.jsonl', rows);

  const corrections = [{ id: 'corr-approved', status: 'approved', city: '杭州', stopName: '柳浪闻莺', createdAt: '2026-01-01T00:00:00.000Z' }];
  for (let index = 0; index < 300; index += 1) {
    corrections.push({ id: `corr-${index}`, status: 'pending', city: '上海', stopName: '武康路', createdAt: '2026-01-02T00:00:00.000Z' });
  }
  await writeJsonl(dataDir, 'poi-corrections.jsonl', corrections);

  const knowledge = [{ id: 'k-hz', city: '杭州', stopName: '柳浪闻莺', field: '营业时间', value: '全天', status: 'approved' }];
  for (let index = 0; index < 900; index += 1) {
    knowledge.push({ id: `k-sh-${index}`, city: '上海', stopName: `站点${index}`, field: '营业时间', value: '9-18', status: 'approved' });
  }
  await writeJsonl(dataDir, 'poi-knowledge.jsonl', knowledge);
  server = await startServer({ dataDir });
});
after(async () => {
  await server?.stop();
});

test('city + status filter returns matches beyond the global window', async () => {
  const result = await fetchJson(`${server.baseUrl}/api/routebooks?city=${encodeURIComponent('杭州')}&status=published&limit=1`);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.deepEqual(
    result.data.routebooks.map((item) => item.publicId),
    ['rb-hz-old']
  );
});

test('filters apply to the latest version only (archived routebook stays hidden)', async () => {
  const result = await fetchJson(`${server.baseUrl}/api/routebooks?city=${encodeURIComponent('杭州')}&status=published&limit=50`);
  assert.deepEqual(
    result.data.routebooks.map((item) => item.publicId),
    ['rb-hz-old']
  );
});

test('profileId filter finds the owner routebook behind 520 newer ones', async () => {
  const result = await fetchJson(`${server.baseUrl}/api/routebooks?profileId=p_owner&limit=5`, { headers: adminHeaders() });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.deepEqual(
    result.data.routebooks.map((item) => item.publicId),
    ['rb-hz-old']
  );
});

test('creator profile finds routebooks older than the latest 500', async () => {
  const result = await fetchJson(`${server.baseUrl}/api/creators/creator-a`);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.profile.routebookCount ?? result.data.profile.stats?.routebookCount, 1, JSON.stringify(result.data.profile).slice(0, 400));
});

test('poi-corrections status filter is applied during the scan', async () => {
  const result = await fetchJson(`${server.baseUrl}/api/poi-corrections?status=approved&limit=1`, { headers: adminHeaders() });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.deepEqual(
    result.data.corrections.map((item) => item.id),
    ['corr-approved']
  );
});

test('poi-knowledge city filter is applied during the scan', async () => {
  const result = await fetchJson(`${server.baseUrl}/api/poi-knowledge?city=${encodeURIComponent('杭州')}&limit=1`);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.deepEqual(
    result.data.knowledge.map((item) => item.id),
    ['k-hz']
  );
});

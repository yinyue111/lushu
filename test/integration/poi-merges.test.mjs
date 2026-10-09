import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ADMIN_TOKEN, adminHeaders, fetchJson, jsonHeaders, startServer, writeJsonl } from '../helpers/server.mjs';

// Fixture POI (test data only): an approved operational entry that duplicates a seed.
const OP_POI = {
  schemaVersion: 1,
  poiId: 'poi-op-liulang-park',
  city: '杭州',
  name: '柳浪闻莺公园东门',
  aliases: [],
  category: '',
  location: { lat: 30.2424, lng: 120.1619, address: '' },
  sourceKind: 'operational',
  sourceType: 'first-party',
  reviewStatus: 'approved',
  facts: [],
  evidence: [],
  audits: []
};

test('POI dedup: queue → human merge → lookups redirect → unmerge restores; decisions are audited', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'routebook-poi-merge-'));
  await writeJsonl(dataDir, 'pois.jsonl', [{ kind: 'poi-batch', rows: [OP_POI] }]);
  const server = await startServer({ dataDir });
  t.after(server.stop);
  /** @param {string} path @param {Record<string, string>} [headers] */
  const get = (path, headers = adminHeaders()) => fetchJson(`${server.baseUrl}${path}`, { headers });
  /** @param {any} body @param {Record<string, string>} [headers] */
  const post = (body, headers = adminHeaders()) =>
    fetchJson(`${server.baseUrl}/api/ops/poi-merges`, { method: 'POST', headers: jsonHeaders(headers), body: JSON.stringify(body) });
  const resolveId = async (name) => (await get(`/api/pois/resolve?city=杭州&name=${encodeURIComponent(name)}`, {})).data.poi.poiId;

  assert.ok([401, 403].includes((await get('/api/ops/poi-duplicates', {})).status));
  const queue = await get('/api/ops/poi-duplicates?city=杭州');
  assert.equal(queue.status, 200, JSON.stringify(queue.data));
  const pair = queue.data.candidates.find((candidate) => candidate.pairKey === 'poi-hz-liulang-wenying|poi-op-liulang-park');
  assert.ok(pair, 'seed and operational duplicate are proposed');
  assert.equal(pair.nameMatch, 'contains');
  assert.equal(await resolveId('柳浪闻莺公园东门'), 'poi-op-liulang-park');

  const base = { canonicalPoiId: 'poi-hz-liulang-wenying', duplicatePoiId: 'poi-op-liulang-park' };
  assert.equal((await post({ ...base, decision: 'merge', reason: '短' })).data.code, 'OPS_AUDIT_REASON_REQUIRED');
  assert.equal((await post({ ...base, decision: 'merge', reason: '人工核对：同一公园的入口条目', actor: 'x' })).status, 400);
  const merged = await post({ ...base, decision: 'merge', reason: '人工核对：同一公园的入口条目' });
  assert.equal(merged.status, 200, JSON.stringify(merged.data));
  assert.match(merged.data.decision.actor, /^admin-[0-9a-f]{12}$/);
  assert.ok(!JSON.stringify(merged.data).includes(ADMIN_TOKEN));

  assert.equal(await resolveId('柳浪闻莺公园东门'), 'poi-hz-liulang-wenying');
  const afterMerge = await get('/api/ops/poi-duplicates?city=杭州');
  assert.ok(!afterMerge.data.candidates.some((candidate) => candidate.pairKey === pair.pairKey));
  assert.deepEqual(
    afterMerge.data.merges.map((merge) => merge.duplicatePoiId),
    ['poi-op-liulang-park']
  );

  // No chains, no reject while merged.
  const chain = await post({ canonicalPoiId: 'poi-op-liulang-park', duplicatePoiId: 'poi-hz-maojiabu', decision: 'merge', reason: '测试链式合并会被拒绝' });
  assert.equal(chain.status, 409);
  assert.equal((await post({ ...base, decision: 'reject', reason: '测试已合并时不能直接驳回' })).data.code, 'POI_MERGE_ACTIVE');
  assert.equal(
    (await post({ canonicalPoiId: 'poi-hz-liulang-wenying', duplicatePoiId: 'poi-sh-anfu-road', decision: 'merge', reason: '跨城合并必须被拒绝' })).data.code,
    'POI_MERGE_CITY_MISMATCH'
  );

  const unmerged = await post({ ...base, decision: 'unmerge', reason: '复核后发现是独立入口，撤销' });
  assert.equal(unmerged.status, 200);
  assert.equal(await resolveId('柳浪闻莺公园东门'), 'poi-op-liulang-park');
  assert.ok((await get('/api/ops/poi-duplicates?city=杭州')).data.candidates.some((candidate) => candidate.pairKey === pair.pairKey));

  const history = await get('/api/ops/poi-merges');
  assert.deepEqual(
    history.data.decisions.map((row) => row.decision),
    ['unmerge', 'merge']
  );
});

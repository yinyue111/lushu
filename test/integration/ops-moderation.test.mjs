import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { adminHeaders, fetchJson, jsonHeaders, startServer, writeJsonl } from '../helpers/server.mjs';

let server;
let dataDir;
let sourceId;
const routeId = 'ops-audit-route';
const now = new Date().toISOString();
const source = {
  url: 'https://example.com/guide',
  finalUrl: 'https://example.com/guide',
  platform: '官方示例',
  platformId: 'web',
  status: 'fetched',
  title: '柳浪闻莺开放时间',
  description: '柳浪闻莺官方示例',
  excerpt: '柳浪闻莺全天开放',
  trustScore: 80,
  signals: ['可验证网页'],
  warnings: [],
  fetchedAt: now
};
source.proof = createHmac('sha256', 'unit-test-profile-secret')
  .update(
    [
      source.url,
      source.finalUrl,
      source.platform,
      source.platformId,
      source.status,
      source.title,
      source.description,
      source.excerpt,
      source.trustScore,
      source.signals.join(';'),
      source.warnings.join(';'),
      source.fetchedAt
    ].join('|')
  )
  .digest('hex');
const stop = {
  id: 'stop-1',
  localStopKey: 'stop-1',
  name: '柳浪闻莺',
  poiId: 'poi-hz-liulang-wenying',
  day: '第1天',
  lat: 30.242,
  lng: 120.1617,
  stay: '30分钟',
  cost: '免费',
  geoConfidence: 98
};

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'lushu-ops-moderation-'));
  await writeJsonl(dataDir, 'routebooks.jsonl', [
    {
      id: routeId,
      publicId: routeId,
      title: '审计回归路书',
      city: '杭州',
      stops: [stop],
      importedSources: [source],
      publishStatus: 'published',
      version: 1,
      createdAt: now
    }
  ]);
  const checkins = [1, 2, 3].map((index) => ({
    id: `ops-checkin-${index}`,
    profileId: `p_ops${index}`,
    routeId,
    localStopKey: stop.id,
    stopId: stop.id,
    stopName: stop.name,
    poiId: stop.poiId,
    city: '杭州',
    status: 'visited',
    trustState: 'profile-owned',
    serverResolvedStop: true,
    arrival: { valid: true, confidence: 'valid' },
    worth: '值得',
    createdAt: now
  }));
  await writeJsonl(dataDir, 'checkins.jsonl', checkins);
  await writeJsonl(dataDir, 'imports.jsonl', [
    { id: 'ops-import', createdAt: now, sources: [source, { url: 'https://example.com/legacy', title: '无签名历史来源' }] }
  ]);
  await writeJsonl(dataDir, 'reviews.jsonl', [
    {
      id: 'ops-review',
      publicId: 'ops-review',
      routebookId: routeId,
      profileId: 'p_ops1',
      routebook: { id: routeId, stops: [stop], publishStatus: 'published' },
      checkins: [{ ...checkins[0], sourceCheckinId: checkins[0].id }],
      executionStops: [{ ...stop, tripStatus: 'visited' }],
      stats: { completionRate: 100, checkinCount: 1 },
      createdAt: now
    }
  ]);
  server = await startServer({ dataDir });
  const imports = await fetchJson(`${server.baseUrl}/api/ops/imports`, { headers: adminHeaders() });
  assert.equal(imports.status, 200, JSON.stringify(imports.data));
  sourceId = imports.data.imports[0].sources[0].sourceId;
});
after(async () => {
  await server?.stop();
  await rm(dataDir, { recursive: true, force: true });
});

const post = (path, body, authorized = true) =>
  fetchJson(`${server.baseUrl}${path}`, { method: 'POST', headers: jsonHeaders(authorized ? adminHeaders() : {}), body: JSON.stringify(body) });
const auditCheckin = (action, extra = {}) => post('/api/ops/checkins/ops-checkin-1/audits', { action, reason: '隔离回归核验处置原因', ...extra });

test('ops writes require admin and server-owned audit fields', async () => {
  assert.equal((await post('/api/ops/checkins/ops-checkin-1/audits', { action: 'exclude', reason: '隔离回归核验处置原因' }, false)).status, 403);
  assert.equal((await auditCheckin('exclude', { reason: '短' })).data.code, 'OPS_AUDIT_REASON_REQUIRED');
  assert.equal((await auditCheckin('exclude', { actor: 'forged' })).data.code, 'OPS_AUDIT_SERVER_FIELDS_FORBIDDEN');
});

test('exclude/restore and incentive marking project into public trust and saved reviews', async () => {
  const share = () => fetchJson(`${server.baseUrl}/api/share/${routeId}`);
  const before = await share();
  assert.equal(before.data.routebook.trustMeta.sampleCount, 3);
  const excluded = await auditCheckin('exclude');
  assert.equal(excluded.status, 200, JSON.stringify(excluded.data));
  assert.equal((await share()).data.routebook.trustMeta.sampleCount, 2);
  const review = await fetchJson(`${server.baseUrl}/api/reviews/ops-review`);
  assert.equal(review.data.review.checkins.length, 0);
  assert.equal(review.data.review.executionStops[0].tripStatus, 'pending');
  assert.equal((await auditCheckin('restore')).status, 200);
  assert.equal((await share()).data.routebook.trustMeta.sampleCount, 3);
  assert.equal((await auditCheckin('mark-commercial-incentive')).status, 200);
  assert.equal((await share()).data.routebook.trustMeta.sampleCount, 2);
  assert.equal((await auditCheckin('clear-commercial-incentive')).status, 200);
  assert.equal((await share()).data.routebook.trustMeta.sampleCount, 3);
  const history = await fetchJson(`${server.baseUrl}/api/ops/audits?entityType=checkin&entityId=ops-checkin-1`, { headers: adminHeaders() });
  assert.equal(history.data.events.length, 4);
  assert.ok(history.data.events.every((event) => event.actor.startsWith('admin-') && event.reason && event.createdAt));
});

test('signed source authorization, feature and revoke change public citations immediately', async () => {
  const audit = (body) => post(`/api/ops/import-sources/${sourceId}/audits`, { reason: '已核验公开引用授权文件', ...body });
  const share = () => fetchJson(`${server.baseUrl}/api/share/${routeId}`);
  assert.equal((await share()).data.routebook.stops[0].sourceEvidence.length, 0);
  const authorized = await audit({ action: 'update-authorization', authorizationStatus: 'authorized-public', authorizationScope: 'public-routebook-citation' });
  assert.equal(authorized.status, 200, JSON.stringify(authorized.data));
  assert.ok((await share()).data.routebook.stops[0].sourceEvidence.some((item) => item.sourceId === sourceId));
  assert.equal((await audit({ action: 'feature' })).status, 200);
  let imports = await fetchJson(`${server.baseUrl}/api/ops/imports`, { headers: adminHeaders() });
  assert.equal(imports.data.imports[0].sources[0].opsFeatured, true);
  assert.equal((await audit({ action: 'revoke-authorization' })).status, 200);
  assert.equal((await share()).data.routebook.stops[0].sourceEvidence.length, 0);
  imports = await fetchJson(`${server.baseUrl}/api/ops/imports`, { headers: adminHeaders() });
  assert.equal(imports.data.imports[0].sources[0].opsFeatured, false);
  const legacyId = imports.data.imports[0].sources[1].sourceId;
  const legacy = await post(`/api/ops/import-sources/${legacyId}/audits`, {
    action: 'update-authorization',
    authorizationStatus: 'authorized-public',
    authorizationScope: 'public-routebook-citation',
    reason: '尝试提升无签名历史来源'
  });
  assert.equal(legacy.data.code, 'OPS_SOURCE_PROOF_REQUIRED');
});

test('existing POI status changes require a new audit note and preserve two-phase commit', async () => {
  const row = { poiId: 'poi-audit-test', city: '杭州', name: '审计测试地点', location: { lat: 30.242, lng: 120.1617 }, reviewStatus: 'pending' };
  let validation = await post('/api/pois/validate', { rows: [row] });
  let saved = await post('/api/pois/upsert', { rows: [row], batchId: validation.data.batchId, commitToken: validation.data.commitToken });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  row.reviewStatus = 'rejected';
  validation = await post('/api/pois/validate', { rows: [row] });
  assert.equal(validation.data.canCommit, false);
  assert.ok(validation.data.rows[0].errors.some((error) => error.code === 'REVIEW_AUDIT_NOTE_REQUIRED'));
  row.audits = [{ note: '核验后当前信息不符合要求', action: 'manual-review', createdAt: now, source: 'ops-editor' }];
  validation = await post('/api/pois/validate', { rows: [row] });
  assert.equal(validation.data.canCommit, true);
  saved = await post('/api/pois/upsert', { rows: [row], batchId: validation.data.batchId, commitToken: validation.data.commitToken });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
});

// Admin console services: config save / test-run gate / restore / export, role table, TOTP, corrections.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'admin-console-'));
process.env.ROUTEBOOK_DATA_DIR = dataDir;
process.env.ENRICH_ENABLED = 'false';
process.env.AI_RUNTIME_FROM_CODEX = 'false';
process.env.OPENAI_BASE_URL = 'http://127.0.0.1:9';
process.env.OPENAI_API_KEY = 'test-fake-key';
writeFileSync(
  join(dataDir, 'routebooks.jsonl'),
  `${JSON.stringify({ id: 'rb-a', publicId: 'rb-a', city: '苏州', title: 'A', publishStatus: 'draft', stops: [{ id: 's1', name: '拙政园' }] })}\n` +
    `${JSON.stringify({ id: 'rb-b', publicId: 'rb-b', city: '苏州', title: 'B', publishStatus: 'draft', stops: [{ id: 's9', name: '拙政园' }] })}\n`
);

const runtime = await import('../../server/config/runtime.mjs');
const { adminStore } = await import('../../server/admin/store.mjs');
const svc = await import('../../server/admin/configService.mjs');
const { can, PERMISSIONS } = await import('../../server/admin/permissions.mjs');
const { totpAt, verifyTotp, base32Encode } = await import('../../server/admin/totp.mjs');
const { enrichStore } = await import('../../server/enrich/store.mjs');
const { applyCorrection, listCorrectionQueue } = await import('../../server/admin/corrections.mjs');
const { reportEnrichment } = await import('../../server/enrich/service.mjs');
const { verifiedFactClaim } = await import('../../server/admin/verifiedFacts.mjs');

runtime.configureRuntimeConfig({ store: adminStore });
const admin = { id: 'adm_1', username: 'root', role: 'admin' };
const operator = { id: 'adm_2', username: 'op', role: 'operator' };
const req = { socket: { remoteAddress: '127.0.0.1' }, headers: {} };

test('save: needs a reason, bumps the version, applies at once and is audited old → new', async () => {
  await assert.rejects(svc.saveConfig({ admin, req, values: { 'generation.dailyLimit': 10 }, reason: '' }), { code: 'ADMIN_REASON_REQUIRED' });
  const before = runtime.getConfig('generation.dailyLimit');
  const saved = await svc.saveConfig({ admin, req, values: { 'generation.dailyLimit': 10 }, reason: '成本收紧测试' });
  assert.equal(saved.version, 1);
  assert.equal(runtime.getConfig('generation.dailyLimit'), 10);
  const audit = (await adminStore().listAudit({ action: 'config.save' }))[0];
  assert.deepEqual(audit.detail.before, [{ key: 'generation.dailyLimit', value: before }]);
  assert.deepEqual(audit.detail.after, [{ key: 'generation.dailyLimit', value: 10 }]);
  assert.equal(audit.actor, 'root');
  await assert.rejects(svc.saveConfig({ admin, req, values: { 'generation.dailyLimit': 10 }, reason: '再来一次' }), { code: 'ADMIN_CONFIG_NO_CHANGES' });
});

test('restore copies an old version into a new one; audit keeps the chain', async () => {
  await svc.saveConfig({ admin, req, values: { 'generation.dailyLimit': 20, 'registration.mode': 'invite' }, reason: '第二版配置' });
  assert.equal(runtime.getConfig('registration.mode'), 'invite');
  const restored = await svc.restoreConfig({ admin, req, version: 1, reason: '回到上一版' });
  assert.equal(restored.version, 3);
  assert.equal(restored.restoredFrom, 1);
  assert.equal(runtime.getConfig('generation.dailyLimit'), 10);
  assert.equal(runtime.getConfig('registration.mode'), 'open');
  const versions = await svc.listVersions();
  assert.deepEqual(versions.map((v) => v.version), [3, 2, 1]);
  const audit = (await adminStore().listAudit({ action: 'config.restore' }))[0];
  assert.equal(audit.detail.restoredFrom, 1);
  assert.ok(audit.detail.before.some((c) => c.key === 'registration.mode' && c.value === 'invite'));
});

test('reverting a key to null goes back to the env default', async () => {
  await svc.saveConfig({ admin, req, values: { 'generation.dailyLimit': null }, reason: '回到 env' });
  assert.equal(runtime.getConfig('generation.dailyLimit'), 300);
});

test('model change needs a successful test-run of the same draft; failure blocks unless an admin force-saves', async () => {
  const draft = { model: 'backup-model', timeoutMs: 60000, reasoningEffort: 'low' };
  await assert.rejects(svc.saveConfig({ admin, req, values: { 'model.deep': draft }, reason: '切到备用模型' }), { code: 'ADMIN_TEST_RUN_REQUIRED' });

  svc.setModelTesterForTests(async () => ({ ok: false, usage: null, error: 'HTTP 503' }));
  const failed = await svc.testRunModel({ admin, req, tier: 'deep', draft });
  assert.equal(failed.ok, false);
  await assert.rejects(svc.saveConfig({ admin, req, values: { 'model.deep': draft }, reason: '切到备用模型', testRunIds: [failed.testRunId] }), { code: 'ADMIN_TEST_RUN_REQUIRED' });

  svc.setModelTesterForTests(async () => ({ ok: true, usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 }, error: '' }));
  const ok = await svc.testRunModel({ admin, req, tier: 'deep', draft });
  assert.equal(ok.ok, true);
  assert.equal(ok.cost, null, 'no price configured → cost unknown, never guessed');
  // A different draft than the one tested is still refused.
  await assert.rejects(svc.saveConfig({ admin, req, values: { 'model.deep': { ...draft, model: 'other' } }, reason: '换别的模型', testRunIds: [ok.testRunId] }), { code: 'ADMIN_TEST_RUN_REQUIRED' });
  const saved = await svc.saveConfig({ admin, req, values: { 'model.deep': draft }, reason: '切到备用模型', testRunIds: [ok.testRunId] });
  assert.equal(saved.forced, false);
  assert.equal(runtime.getConfig('model.deep').model, 'backup-model');

  const forced = await svc.saveConfig({ admin, req, values: { 'model.deep': { ...draft, model: 'forced-model' } }, reason: '上游全挂，先强制切', force: true });
  assert.equal(forced.forced, true);
  const audit = (await adminStore().listAudit({ action: 'config.save' }))[0];
  assert.equal(audit.detail.forcedWithoutTestRun, true);
  svc.setModelTesterForTests(null);
});

test('test-runs are rate-limited per admin per hour', async () => {
  svc.setModelTesterForTests(async () => ({ ok: true, usage: null, error: '' }));
  await svc.saveConfig({ admin, req, values: { 'admin.testRunsPerHour': 3 }, reason: '限流测试' });
  // 2 runs already happened in the previous test.
  await svc.testRunModel({ admin, req, tier: 'fast' });
  await assert.rejects(svc.testRunModel({ admin, req, tier: 'fast' }), (e) => e.code === 'ADMIN_TEST_RUN_LIMIT' && e.retryAfterSeconds > 0);
  svc.setModelTesterForTests(null);
});

test('two-source switch off needs explicit confirmation; home cities must be open', async () => {
  await assert.rejects(svc.saveConfig({ admin, req, values: { 'enrich.requireTwoSources': false }, reason: '试试单来源' }), { code: 'ADMIN_CONFIRM_REQUIRED' });
  await svc.saveConfig({ admin, req, values: { 'enrich.requireTwoSources': false }, reason: '试试单来源', confirmTwoSourceOff: true });
  assert.equal(runtime.getConfig('enrich.requireTwoSources'), false);
  await svc.saveConfig({ admin, req, values: { 'enrich.requireTwoSources': true }, reason: '恢复两来源' });
  await assert.rejects(svc.saveConfig({ admin, req, values: { 'generation.homeCities': ['成都'] }, reason: '推荐成都' }), /不在开放范围内/);
});

test('secrets are write-only: config view and export never contain the value', async () => {
  await svc.saveConfig({ admin, req, secrets: { 'enrich.apiKey': 'sk-very-secret-value-1' }, reason: '换补全 key' });
  const view = await svc.configView();
  const exported = await svc.exportConfig();
  const audits = await adminStore().listAudit({});
  for (const blob of [view, exported, audits]) assert.ok(!JSON.stringify(blob).includes('sk-very-secret-value-1'));
  assert.equal(view.secrets.find((s) => s.key === 'enrich.apiKey').state, 'db');
  assert.deepEqual(Object.keys(exported.secrets), ['enrich.apiKey']);
  assert.equal(exported.secrets['enrich.apiKey'].redacted, true);
  assert.match(exported.secrets['enrich.apiKey'].fingerprint, /^sha256:/);
  assert.equal(exported.format, 'lushu-runtime-config');
  assert.equal(runtime.getSecret('enrich.apiKey'), 'sk-very-secret-value-1');
});

test('role table: operators cannot touch models, quota config, restore, export, invites or admin accounts', () => {
  for (const p of ['config.write', 'config.restore', 'config.export', 'config.testRun', 'invites.manage', 'admins.manage', 'corrections.batch', 'audit.read.all']) {
    assert.equal(can('operator', p), false, p);
    assert.equal(can('admin', p), true, p);
  }
  for (const p of ['corrections.write', 'users.write', 'users.quota', 'roadbooks.write', 'dashboard.read', 'system.read', 'config.read', 'audit.read.own']) assert.equal(can('operator', p), true, p);
  assert.equal(can('script', 'config.read'), false);
  assert.ok(Object.values(PERMISSIONS).every((roles) => roles.includes('admin')), 'admin can do everything operators can');
});

test('TOTP matches the RFC 6238 SHA-1 vector and accepts ±1 step only', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(totpAt(secret, 1), '287082'); // T=59s
  assert.equal(totpAt(secret, Math.floor(1111111109 / 30)), '081804');
  const now = 1111111109 * 1000;
  assert.ok(verifyTotp(secret, '081804', now));
  assert.ok(verifyTotp(secret, totpAt(secret, Math.floor(now / 30000) - 1), now));
  assert.equal(verifyTotp(secret, totpAt(secret, Math.floor(now / 30000) - 3), now), 0);
  assert.equal(verifyTotp(secret, 'abc', now), 0);
});

test('corrections: report → queue with sources; reset / verify (source required) / reject; batch by cache key is admin-only', async () => {
  const store = enrichStore();
  const claim = (stopKey) => ({
    stopKey,
    stopName: '拙政园',
    field: 'price',
    status: 'filled',
    value: '80 元',
    display: '门票：80 元',
    cacheKey: '苏州|拙政园|price',
    method: 'pages',
    retrievedAt: '2026-10-01T00:00:00.000Z',
    sources: [{ kind: 'web', url: 'https://example.gov.cn/a', title: '官网', domain: 'example.gov.cn', quote: '门票 80 元（旺季）' }]
  });
  await store.enqueue({ routebookId: 'rb-a', userId: 'u1' });
  await store.putResult('rb-a', [claim('s1')]);
  await store.enqueue({ routebookId: 'rb-b', userId: 'u2' });
  await store.putResult('rb-b', [claim('s9')]);
  await store.putCache('苏州|拙政园|price', { status: 'filled', value: '80 元' }, new Date(Date.now() + 86400000).toISOString());

  assert.deepEqual(await reportEnrichment({ routebookId: 'rb-a', stopKey: 's1', field: 'price', note: '淡季 70', userId: 'u1' }), { ok: true });
  let [item] = await listCorrectionQueue({ status: 'open' });
  assert.equal(item.city, '苏州');
  assert.equal(item.sources[0].url, 'https://example.gov.cn/a');
  assert.equal(item.sources[0].quote, '门票 80 元（旺季）');
  assert.ok(item.sources[0].retrievedAt);
  assert.equal(item.affectedRoutebooks, 2);

  // reject → original value shows again
  await applyCorrection({ admin: operator, req, reportId: item.id, action: 'reject', reason: '核对无误' });
  assert.equal((await store.getResult('rb-a')).claims[0].status, 'filled');
  assert.equal((await listCorrectionQueue({ status: 'rejected' })).length, 1);

  // verify without a source → refused
  await assert.rejects(applyCorrection({ admin: operator, req, routebookId: 'rb-a', stopKey: 's1', field: 'price', action: 'verify', value: '70 元', sources: [], reason: '官网核实' }), { code: 'ADMIN_VERIFY_SOURCE_REQUIRED' });
  await applyCorrection({ admin: operator, req, routebookId: 'rb-a', stopKey: 's1', field: 'price', action: 'verify', value: '淡季 70 元', sources: [{ url: 'https://example.gov.cn/price', retrievedAt: '2026-10-13' }], reason: '官网核实' });
  const verified = (await store.getResult('rb-a')).claims[0];
  assert.equal(verified.method, 'ops-verified');
  assert.match(verified.display, /人工核实 · \d{4}-\d{2}-\d{2}/);
  const fact = await verifiedFactClaim('苏州|拙政园|price');
  assert.equal(fact.value, '淡季 70 元');
  assert.ok(Date.parse(fact.expiresAt) - Date.now() > 89 * 86400000, 'manual verification lasts 90 days by default');

  // batch reset by cache key: operator refused, admin resets every routebook with that key + drops cache/fact
  await assert.rejects(applyCorrection({ admin: operator, req, routebookId: 'rb-a', stopKey: 's1', field: 'price', action: 'reset', batch: true, reason: '全部改回' }), { code: 'ADMIN_FORBIDDEN' });
  const reset = await applyCorrection({ admin, req, routebookId: 'rb-a', stopKey: 's1', field: 'price', action: 'reset', batch: true, reason: '全部改回' });
  assert.deepEqual(reset.routebooks.sort(), ['rb-a', 'rb-b']);
  assert.equal((await store.getResult('rb-b')).claims[0].status, 'disputed');
  assert.equal(await store.getCache('苏州|拙政园|price'), null);
  assert.equal(await verifiedFactClaim('苏州|拙政园|price'), null);

  const audits = await adminStore().listAudit({ action: 'correction.' });
  assert.deepEqual(audits.map((a) => a.action), ['correction.reset', 'correction.verify', 'correction.reject']);
  assert.equal(audits[1].detail.before.value, '80 元');
  assert.equal(audits[1].detail.after.value, '淡季 70 元');
});

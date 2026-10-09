import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataDir = await mkdtemp(path.join(tmpdir(), 'jev-shadow-'));
process.env.ROUTEBOOK_DATA_DIR = dataDir;
delete process.env.JEV_SHADOW_ENABLED;
delete process.env.TYPESAFE_API_KEY;

const { callSystemOne } = await import('../../server/shadow/systemOne.mjs');
const { assertNoPersonalData, redactPublicText } = await import('../../server/shadow/privacy.mjs');
const { SHADOW_TASKS, summarizeShadowJudgments } = await import('../../server/shadow/tasks.mjs');
const shadow = await import('../../server/shadow/index.mjs');
const { createJevMockServer } = await import('../../scripts/jev/mock-server.mjs');
const { SHADOW_JUDGMENT_LOG_PATH } = await import('../../server/config/index.mjs');

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

async function withMock(options, fn) {
  const { server, requests } = createJevMockServer(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = /** @type {any} */ (server.address());
  try {
    return await fn(`http://127.0.0.1:${address.port}/v1/systemone`, requests);
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
}

async function readShadowRows() {
  const raw = await readFile(SHADOW_JUDGMENT_LOG_PATH, 'utf8').catch(() => '');
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test('shadow mode is off by default and scheduling never throws', () => {
  assert.equal(shadow.shadowModeEnabled(), false);
  assert.equal(shadow.scheduleShadowJudgment('import-gate', { source: {} }), 'disabled');
  assert.equal(shadow.scheduleShadowJudgment('no-such-task', {}), 'disabled');
});

test('client sends the documented request shape and handles errors and timeouts', async () => {
  await withMock({ apiKey: 'mock-key' }, async (url, requests) => {
    const result = await callSystemOne({ state: 'x', questions: { q: { type: 'noul', instructions: '?' } } }, { apiKey: 'mock-key', url });
    assert.equal(result.ok, true);
    assert.equal(result.answers.q.noul, 0.5);
    assert.equal(requests[0].model, 'jev-latest');
    const unauthorized = await callSystemOne({ state: 'x', questions: {} }, { apiKey: 'wrong', url });
    assert.deepEqual([unauthorized.ok, unauthorized.error], [false, 'http-401']);
  });
  await withMock({ delayMs: 400 }, async (url) => {
    const slow = await callSystemOne({ state: 'x', questions: {} }, { apiKey: 'k', url, timeoutMs: 100 });
    assert.deepEqual([slow.ok, slow.error], [false, 'timeout']);
  });
  assert.equal((await callSystemOne({ state: 'x', questions: {} }, { apiKey: '' })).error, 'no-api-key');
  const malformed = await callSystemOne({ state: 'x', questions: {} }, { apiKey: 'k', fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
  assert.equal(malformed.error, 'malformed-response');
});

test('privacy guard redacts contact details and blocks personal fields', () => {
  assert.equal(redactPublicText('电话 13912345678 邮箱 a.b@example.com'), '电话 [手机号] 邮箱 [邮箱]');
  assert.throws(() => assertNoPersonalData({ entity: { profileId: 'p1' } }), /profileId/);
  assert.throws(() => assertNoPersonalData({ list: [{ lat: 1 }] }), /lat/);
  assert.doesNotThrow(() => assertNoPersonalData({ title: '西湖一日游', excerpt: '…' }));
  for (const [name, task] of Object.entries(SHADOW_TASKS)) {
    const built = task.build({
      source: { title: 't', excerpt: 'e', platform: 'web', profileId: 'p' },
      a: { name: 'A', lat: 30, lng: 120, profileId: 'p' },
      b: { name: 'B' },
      candidates: [{ id: 'x', name: 'X', address: '', typecode: '', lat: 1, lng: 2 }],
      stopName: 'X'
    });
    assert.doesNotThrow(() => assertNoPersonalData(built.state), name);
  }
});

test('geocode task keeps keys stable across shuffled option order', () => {
  const built = SHADOW_TASKS['geocode-choice'].build({
    stopName: '灵隐寺',
    city: '杭州',
    candidates: [
      { id: 'a', name: '灵隐寺' },
      { id: 'b', name: '灵隐寺停车场' }
    ],
    ruleChosenId: 'a'
  });
  assert.equal(built.ruleDecision, 'c_0');
  assert.deepEqual(Object.keys(built.questions.pick.criteria), ['c_0', 'c_1', 'none_match']);
  assert.deepEqual(Object.keys(built.shuffledQuestions.pick.criteria), ['none_match', 'c_1', 'c_0']);
  assert.equal(SHADOW_TASKS['geocode-choice'].build({ candidates: [{ id: 'a' }], ruleChosenId: 'zz' }).ruleDecision, 'none_match');
});

test('scheduled judgments run in the background, log agreement and order consistency', async () => {
  await withMock({ noulOverrides: { is_travel_content: 0.9, is_shell_page: 0.1 } }, async (url, requests) => {
    shadow.setShadowOverridesForTests({
      enabled: true,
      client: (/** @type {any} */ request) => callSystemOne(request, { apiKey: 'k', url })
    });
    const status = shadow.scheduleShadowJudgment('import-gate', {
      source: { platform: '网页', title: '杭州一日游', excerpt: '联系 13912345678', status: 'fetched' },
      city: '杭州',
      ruleUsable: true
    });
    assert.equal(status, 'scheduled');
    assert.equal(requests.length, 0, 'nothing is sent on the caller path');
    shadow.scheduleShadowJudgment('geocode-choice', {
      stopName: '灵隐寺',
      city: '杭州',
      candidates: [
        { id: 'a', name: '灵隐寺' },
        { id: 'b', name: '灵隐寺停车场' }
      ],
      ruleChosenId: 'a'
    });
    await shadow.drainShadowJudgments();
    assert.equal(requests.length, 4, 'each task asks twice (original + shuffled order)');
    assert.ok(!JSON.stringify(requests).includes('13912345678'), 'phone numbers are redacted');
    const rows = await readShadowRows();
    const gate = rows.find((row) => row.task === 'import-gate');
    assert.equal(gate.ok, true);
    assert.equal(gate.jevDecision, 'usable');
    assert.equal(gate.agreement, true);
    const geo = rows.find((row) => row.task === 'geocode-choice');
    // The mock always picks the first listed option, so the reversed retest disagrees.
    assert.equal(geo.orderConsistent, false);
    const summary = summarizeShadowJudgments(rows);
    assert.equal(summary['import-gate'].agreementRate, 100);
    assert.equal(summary['geocode-choice'].orderConsistencyRate, 0);
  });
  await withMock({ status: 529 }, async (url) => {
    shadow.setShadowOverridesForTests({ enabled: true, client: (/** @type {any} */ request) => callSystemOne(request, { apiKey: 'k', url }) });
    shadow.scheduleShadowJudgment('poi-duplicate', { a: { name: 'A' }, b: { name: 'B' }, distanceMeters: 30, humanDecision: 'merge' });
    await shadow.drainShadowJudgments();
    const failed = (await readShadowRows()).find((row) => row.task === 'poi-duplicate');
    assert.deepEqual([failed.ok, failed.error], [false, 'http-529']);
  });
  shadow.setShadowOverridesForTests({ enabled: true, sampleRate: 0.1, random: () => 0.5 });
  assert.equal(shadow.scheduleShadowJudgment('import-gate', { source: {} }), 'sampled-out');
  shadow.setShadowOverridesForTests(null);
});

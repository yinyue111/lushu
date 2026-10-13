// Runtime config: precedence (DB > env > safe default), fallback on DB failure, last-good snapshot,
// whole-snapshot rejection, write-only secrets, export redaction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ROUTEBOOK_DATA_DIR = mkdtempSync(join(tmpdir(), 'admin-cfg-'));
process.env.GENERATION_DAILY_LIMIT = '123';
process.env.REGISTRATION_MODE = 'not-a-mode'; // invalid env → code default ('open', existing behaviour)
const runtime = await import('../../server/config/runtime.mjs');
const { RUNTIME_SCHEMA, parseSetting } = await import('../../server/config/runtimeSchema.mjs');

function fakeStore(initial = null) {
  const state = { latest: initial, fail: false };
  return {
    state,
    store: () => ({
      async latestConfig() {
        if (state.fail) throw new Error('connect ECONNREFUSED');
        return state.latest;
      }
    })
  };
}

test('env values are used when the DB has no config', async () => {
  runtime.resetRuntimeConfigForTests();
  const fake = fakeStore(null);
  runtime.configureRuntimeConfig({ store: fake.store });
  await runtime.refreshConfig();
  assert.equal(runtime.getConfig('generation.dailyLimit'), 123);
  assert.equal(runtime.getConfig('registration.mode'), 'open');
  assert.equal(runtime.configStatus().source, 'env');
  assert.equal(runtime.getConfigVersion(), 0);
});

test('a DB override wins over env for that key only', async () => {
  runtime.resetRuntimeConfigForTests();
  const fake = fakeStore({ version: 3, overrides: { 'generation.dailyLimit': 50 }, secrets: {} });
  runtime.configureRuntimeConfig({ store: fake.store });
  await runtime.refreshConfig();
  assert.equal(runtime.getConfig('generation.dailyLimit'), 50);
  assert.equal(runtime.getConfig('enrich.concurrency'), 2, 'untouched keys keep env/default');
  assert.equal(runtime.getConfigVersion(), 3);
  assert.equal(runtime.configStatus().source, 'db');
});

test('DB unreachable at startup → env defaults; later failure keeps the last good snapshot and alerts once', async () => {
  runtime.resetRuntimeConfigForTests();
  const fake = fakeStore(null);
  fake.state.fail = true;
  const alerts = [];
  runtime.configureRuntimeConfig({ store: fake.store, alert: (k, m) => alerts.push([k, m]) });
  await runtime.refreshConfig();
  assert.equal(runtime.getConfig('generation.dailyLimit'), 123);
  assert.match(runtime.configStatus().error, /ECONNREFUSED/);

  fake.state.fail = false;
  fake.state.latest = { version: 1, overrides: { 'generation.dailyLimit': 7 }, secrets: {} };
  await runtime.refreshConfig();
  assert.equal(runtime.getConfig('generation.dailyLimit'), 7);

  fake.state.fail = true;
  await runtime.refreshConfig();
  await runtime.refreshConfig();
  assert.equal(runtime.getConfig('generation.dailyLimit'), 7, 'last good snapshot stays');
  assert.equal(runtime.configStatus().stale, true);
  assert.equal(alerts.filter(([k]) => k === 'admin-config-stale').length, 1);
});

test('an invalid stored snapshot is rejected as a whole; the previous one stays', async () => {
  runtime.resetRuntimeConfigForTests();
  const fake = fakeStore({ version: 1, overrides: { 'generation.dailyLimit': 9 }, secrets: {} });
  const alerts = [];
  runtime.configureRuntimeConfig({ store: fake.store, alert: (k) => alerts.push(k) });
  await runtime.refreshConfig();
  fake.state.latest = { version: 2, overrides: { 'generation.dailyLimit': 10, 'registration.mode': 'everyone' }, secrets: {} };
  await runtime.refreshConfig();
  assert.equal(runtime.getConfigVersion(), 1);
  assert.equal(runtime.getConfig('generation.dailyLimit'), 9, 'valid keys of the bad version are not applied either');
  assert.deepEqual(alerts, ['admin-config-invalid']);
});

test('change listeners fire when the version moves', async () => {
  runtime.resetRuntimeConfigForTests();
  const fake = fakeStore(null);
  runtime.configureRuntimeConfig({ store: fake.store });
  const seen = [];
  const off = runtime.onConfigChange((next) => seen.push(next.version));
  fake.state.latest = { version: 4, overrides: {}, secrets: {} };
  await runtime.refreshConfig();
  await runtime.refreshConfig();
  off();
  assert.deepEqual(seen, [4]);
});

test('secrets: stored encrypted, decrypted only server-side, env is the fallback', async () => {
  runtime.resetRuntimeConfigForTests();
  process.env.ENRICH_API_KEY = 'env-enrich-key-123';
  assert.equal(runtime.getSecret('enrich.apiKey'), 'env-enrich-key-123');
  const enc = runtime.encryptSecret('db-enrich-key-456');
  assert.ok(!enc.includes('db-enrich-key-456'));
  const fake = fakeStore({ version: 1, overrides: {}, secrets: { 'enrich.apiKey': enc } });
  runtime.configureRuntimeConfig({ store: fake.store });
  await runtime.refreshConfig();
  assert.equal(runtime.getSecret('enrich.apiKey'), 'db-enrich-key-456');
  assert.equal(runtime.secretSource('enrich.apiKey'), 'db');
  assert.match(runtime.secretFingerprint(enc), /^sha256:[0-9a-f]{8}$/);
});

test('schema validation: ranges, enums, cities, model tiers', () => {
  assert.throws(() => parseSetting('generation.dailyLimit', -1), /范围/);
  assert.throws(() => parseSetting('registration.mode', 'all'), /只能是/);
  assert.throws(() => parseSetting('generation.openCities', ['火星']), /不支持/);
  assert.throws(() => parseSetting('generation.openCities', []), /至少/);
  assert.deepEqual(parseSetting('generation.openCities', ['杭州', '杭州', '上海']), ['杭州', '上海']);
  assert.throws(() => parseSetting('model.fast', { model: '', timeoutMs: 5000 }), /model/);
  const tier = parseSetting('model.deep', { model: 'm-1', timeoutMs: 60000, reasoningEffort: 'HIGH', baseUrl: 'https://relay.example/v1/' });
  assert.equal(tier.reasoningEffort, 'high');
  assert.equal(tier.baseUrl, 'https://relay.example/v1');
  assert.throws(() => parseSetting('model.pricing', { m: { input: -1, output: 1 } }), /单价/);
  for (const key of Object.keys(RUNTIME_SCHEMA)) assert.ok(RUNTIME_SCHEMA[key].label, `${key} has a label`);
});

import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createModelRuntimeLoader, parseCodexConfig, redactBaseUrl, resolveModelRuntime } from '../../server/ai/runtime.mjs';

const CONFIG = `model = "codex-model"
model_provider = "yinyue"

[model_providers.yinyue]
base_url = "https://codex.example/v1"
wire_api = "chat_completions"
`;

async function codexHome() {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-test-'));
  await writeFile(join(dir, 'config.toml'), CONFIG);
  await writeFile(join(dir, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'codex-key' }));
  return { configPath: join(dir, 'config.toml'), authPath: join(dir, 'auth.json') };
}

test('parseCodexConfig reads top-level model and provider sections', () => {
  const config = parseCodexConfig(CONFIG);
  assert.equal(config.model, 'codex-model');
  assert.equal(config.modelProvider, 'yinyue');
  assert.equal(config.providers.yinyue.base_url, 'https://codex.example/v1');
  assert.equal(parseCodexConfig('').modelProvider, 'openai');
});

test('H6: Codex files are ignored unless readCodex is enabled', async () => {
  const paths = await codexHome();
  const disabled = await createModelRuntimeLoader({ env: {}, readCodex: false, ...paths })();
  assert.equal(disabled.ready, false);
  assert.equal(disabled.apiKey, undefined);
  assert.equal(disabled.codexConfigUsed, false);
  assert.match(disabled.readyReason, /OPENAI_BASE_URL 未配置/);
  assert.match(disabled.readyReason, /OPENAI_API_KEY 未配置/);
  assert.match(disabled.readyReason, /AI_RUNTIME_FROM_CODEX/);

  const enabled = await createModelRuntimeLoader({ env: {}, readCodex: true, ...paths })();
  assert.equal(enabled.ready, true);
  assert.equal(enabled.apiKey, 'codex-key');
  assert.equal(enabled.wireApi, 'chat_completions');
  assert.equal(enabled.readyReason, '');
});

test('H6: not-ready runtime always explains why (reason was empty before)', () => {
  const runtime = resolveModelRuntime({ env: { OPENAI_BASE_URL: 'https://x.example' }, readCodex: false, configPath: '', authPath: '' });
  assert.equal(runtime.ready, false);
  assert.notEqual(runtime.readyReason, '');
  const badWire = resolveModelRuntime({ env: { OPENAI_BASE_URL: 'https://x', OPENAI_API_KEY: 'k', OPENAI_WIRE_API: 'grpc' }, readCodex: false, configPath: '', authPath: '' });
  assert.match(badWire.readyReason, /wire_api=grpc/);
});

test('env vars take precedence over Codex config', async () => {
  const paths = await codexHome();
  const runtime = await createModelRuntimeLoader({
    env: { OPENAI_BASE_URL: 'https://env.example', OPENAI_API_KEY: 'env-key', OPENAI_MODEL: 'env-model' },
    readCodex: true,
    ...paths
  })();
  assert.equal(runtime.baseUrl, 'https://env.example');
  assert.equal(runtime.apiKey, 'env-key');
  assert.equal(runtime.model, 'env-model');
});

test('runtime loader caches until Codex files change', async () => {
  const paths = await codexHome();
  const load = createModelRuntimeLoader({ env: {}, readCodex: true, ...paths });
  const first = await load();
  assert.equal(await load(), first, 'same object while files are unchanged');
  await new Promise((resolve) => setTimeout(resolve, 20));
  await writeFile(paths.authPath, JSON.stringify({ OPENAI_API_KEY: 'rotated-key-with-different-length' }));
  const second = await load();
  assert.equal(second.apiKey, 'rotated-key-with-different-length');
});

test('redactBaseUrl keeps only origin', () => {
  assert.equal(redactBaseUrl('https://user:pw@host.example:8443/v1?key=1'), 'https://host.example:8443');
  assert.equal(redactBaseUrl(''), null);
  assert.equal(redactBaseUrl('not a url'), '[configured]');
});

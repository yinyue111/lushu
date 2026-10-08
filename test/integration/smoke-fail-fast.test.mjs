import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { hermeticServerEnv } from '../../scripts/lib/hermetic-env.mjs';
import { freePort } from '../helpers/server.mjs';

// M7: smoke:api used to poll /api/health for SMOKE_TIMEOUT_MS (180 s) when the model
// runtime was not configured. It must now fail on the first `ready: false`.
test('smoke:api fails fast when the model runtime is not configured', { timeout: 60000 }, async () => {
  const env = hermeticServerEnv({ SMOKE_PORT: String(await freePort()) });
  for (const key of ['OPENAI_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_MODEL', 'OPENAI_WIRE_API', 'AI_PROVIDER']) delete env[key];
  const started = Date.now();
  const child = spawn(process.execPath, ['scripts/smoke-api.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const code = await new Promise((resolve) => child.on('exit', resolve));
  const elapsed = Date.now() - started;
  assert.equal(code, 1, output);
  assert.match(output, /Model runtime is not ready: .*OPENAI_API_KEY 未配置/);
  assert.ok(elapsed < 30000, `took ${elapsed}ms`);
});

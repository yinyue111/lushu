import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PROJECT_ROOT } from '../helpers/server.mjs';
import { hermeticServerEnv } from '../../scripts/lib/hermetic-env.mjs';

// GENERATION_QUOTA_DEEP_PER_PROFILE caps 细品 runs inside the shared quota; 轻快 is not affected.
test('细品 has its own optional cap; 轻快 keeps the shared quota', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'lushu-deep-quota-'));
  mkdirSync(dataDir, { recursive: true });
  const now = new Date().toISOString();
  const row = (mode) => JSON.stringify({ kind: 'generate-routebook', status: 'ok', profileId: 'p_quota', mode, createdAt: now });
  writeFileSync(join(dataDir, 'ai-generations.jsonl'), [row('deep'), row('deep'), row('fast')].join('\n') + '\n');
  const script = `
    const { AI_LOG_PATH } = await import('./server/config/index.mjs');
    const fs = await import('node:fs');
    fs.copyFileSync(process.env.SEED, AI_LOG_PATH);
    const { enforceGenerationQuota } = await import('./server/ai/generationGuard.mjs');
    const result = {};
    for (const mode of ['deep', 'fast']) {
      try { await enforceGenerationQuota('p_quota', { mode, quota: 10 }); result[mode] = 'ok'; }
      catch (e) { result[mode] = e.code + ':' + e.message; }
    }
    console.log(JSON.stringify(result));`;
  const env = { ...hermeticServerEnv({}), DATA_DIR: dataDir, SEED: join(dataDir, 'ai-generations.jsonl'), GENERATION_QUOTA_DEEP_PER_PROFILE: '2' };
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: PROJECT_ROOT, env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout.trim().split('\n').at(-1));
  assert.match(result.deep, /^GENERATION_QUOTA_EXCEEDED:「细品」次数已达上限/);
  assert.equal(result.fast, 'ok');
});

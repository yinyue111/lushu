import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { rowConsumesQuota } from '../../server/ai/generationGuard.mjs';
import { after, before, test } from 'node:test';
import { API_TOKEN, fetchJson, jsonHeaders, startServer } from '../helpers/server.mjs';

// A fresh deployment with NOTHING configured for fallback (no AI_MODEL_FALLBACK_ORDER, no admin override):
// 细品's upstream fails (403 / 503 / timeout) → the default order (细品 → 轻快) is used,
// the routebook is marked 「本次由备用模型生成」 (provider.fellBackFrom), and a run whose fallback also
// fails reports the original error, offers 「用轻快重试」, and does not consume quota.
let server;
let provider;
/** @type {string[]} */
let calls = [];
const generated = {
  title: '杭州兜底测试',
  city: '杭州',
  days: ['第1天'],
  stops: ['柳浪闻莺', '南宋御街', '北山街'].map((name, index) => ({
    name,
    day: '第1天',
    time: `${10 + index}:00`,
    stay: '30分钟',
    cost: '免费',
    area: '杭州',
    geoConfidence: 90
  }))
};

before(async () => {
  provider = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    calls.push(body.model);
    const prompt = JSON.stringify(body.messages);
    const failing = body.model === 'deep-model-y' || prompt.includes('BOTHFAIL');
    if (failing && prompt.includes('UP403')) {
      res.writeHead(403, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'forbidden' } }));
    }
    if (failing && (prompt.includes('UP503') || prompt.includes('BOTHFAIL'))) {
      res.writeHead(503, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'unavailable' } }));
    }
    if (failing && prompt.includes('UPHANG')) return; // never answers: the 细品 call timeout has to stop it
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(generated) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      })
    );
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = /** @type {import('node:net').AddressInfo} */ (provider.address());
  server = await startServer({
    env: {
      OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      OPENAI_WIRE_API: 'chat_completions',
      AI_MODEL_FAST: 'fast-model-x',
      AI_MODEL_DEEP: 'deep-model-y',
      AI_STREAM: 'false',
      AI_TIMEOUT_MS_FAST: '15000',
      AI_TIMEOUT_MS_DEEP: '1500',
      GENERATION_DEDUP_TTL_MS: '0',
      GENERATION_QUOTA_PER_PROFILE: '1',
      GENERATION_JOB_POLL_WAIT_MS: '1000'
    }
  });
});
after(async () => {
  await server?.stop();
  provider?.closeAllConnections();
  await new Promise((resolve) => provider?.close(() => resolve(undefined)));
});

async function runJob(guide, profileId) {
  calls = [];
  const headers = jsonHeaders({ 'x-routebook-token': API_TOKEN });
  const { status, data } = await fetchJson(`${server.baseUrl}/api/generation-jobs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ city: '杭州', guide, mode: 'deep', profileId })
  });
  if (![200, 202].includes(status)) return { status, data };
  let seq = data.job.seq;
  for (let i = 0; i < 60; i += 1) {
    const polled = await fetchJson(`${server.baseUrl}/api/generation-jobs/${data.job.jobId}?after=${seq}`, { headers });
    seq = polled.data.job.seq;
    if (polled.data.job.status !== 'running') return { status, job: polled.data.job };
  }
  throw new Error('job never finished');
}

for (const [label, keyword] of [
  ['403', 'UP403'],
  ['503', 'UP503'],
  ['timeout', 'UPHANG']
]) {
  test(`细品 upstream ${label} → falls back to 轻快 and marks the routebook`, async () => {
    const { job } = await runJob(`${keyword} 柳浪闻莺和南宋御街`, `fallback-${label}`);
    assert.equal(job.status, 'succeeded', JSON.stringify(job.error));
    assert.deepEqual(calls, ['deep-model-y', 'fast-model-x'], 'one 细品 attempt, then the fallback');
    assert.equal(job.result.provider.mode, 'fast');
    assert.equal(job.result.provider.fellBackFrom, 'deep', 'persisted marker → 「本次由备用模型生成」');
    const stored = await fetchJson(`${server.baseUrl}/api/routebooks/${job.result.publicId || job.result.id}`, {
      headers: jsonHeaders({ 'x-routebook-token': API_TOKEN })
    });
    if (stored.status === 200) assert.equal((stored.data.routebook ?? stored.data).provider.fellBackFrom, 'deep');
  });
}

test('轻快 never falls back to 细品 by default (轻快 failing just fails)', async () => {
  const headers = jsonHeaders({ 'x-routebook-token': API_TOKEN });
  calls = [];
  const { data } = await fetchJson(`${server.baseUrl}/api/generation-jobs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ city: '杭州', guide: 'BOTHFAIL 轻快失败', mode: 'fast' })
  });
  let job = data.job;
  for (let i = 0; i < 60 && job.status === 'running'; i += 1) job = (await fetchJson(`${server.baseUrl}/api/generation-jobs/${job.jobId}?after=${job.seq}`, { headers })).data.job;
  assert.equal(job.status, 'failed');
  assert.deepEqual(calls, ['fast-model-x']);
  assert.equal(job.error.suggestFast, false);
});

test('fallback also fails → original error, 「用轻快重试」 offered, quota not consumed', async () => {
  const profileId = 'fallback-bothfail';
  const failed = await runJob('BOTHFAIL 柳浪闻莺', profileId);
  assert.equal(failed.job.status, 'failed');
  assert.equal(failed.job.error.code, 'MODEL_ERROR');
  assert.equal(failed.job.error.suggestFast, true);
  assert.equal(failed.job.error.fallbackTried.mode, 'fast');
  // Quota is 1 per profile: the failed run must not have used it.
  const next = await runJob('柳浪闻莺和北山街', profileId);
  assert.notEqual(next.status, 429, JSON.stringify(next.data));
  assert.equal(next.job.status, 'succeeded', JSON.stringify(next.job?.error));
  // And by the quota rule itself: the logged failure row is an upstream failure that does not count.
  const rows = (await readFile(join(server.dataDir, 'ai-logs.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const failedRow = rows.find((row) => row.kind === 'generate-routebook' && row.status === 'error' && row.fallbackTried?.mode === 'fast');
  assert.ok(failedRow, 'failure is logged');
  assert.equal(rowConsumesQuota(failedRow, false), false);
  const okRows = rows.filter((row) => row.kind === 'generate-routebook' && row.status === 'ok' && row.fellBackFrom === 'deep');
  assert.ok(okRows.length >= 3 && okRows.every((row) => row.mode === 'fast'), 'fallback runs are logged under the mode that actually ran');
});

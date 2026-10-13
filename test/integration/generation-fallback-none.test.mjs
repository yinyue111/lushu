import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { API_TOKEN, fetchJson, jsonHeaders, startServer } from '../helpers/server.mjs';

// AI_MODEL_FALLBACK_ORDER=none turns the default 细品 → 轻快 fallback off; a typo refuses to start.
let server;
let provider;
/** @type {string[]} */
const calls = [];

before(async () => {
  provider = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    calls.push(JSON.parse(raw).model);
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'unavailable' } }));
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
      AI_MODEL_FALLBACK_ORDER: 'none',
      GENERATION_DEDUP_TTL_MS: '0',
      GENERATION_JOB_POLL_WAIT_MS: '1000'
    }
  });
});
after(async () => {
  await server?.stop();
  provider?.closeAllConnections();
  await new Promise((resolve) => provider?.close(() => resolve(undefined)));
});

test('AI_MODEL_FALLBACK_ORDER=none: 细品 failure does not try 轻快', async () => {
  const headers = jsonHeaders({ 'x-routebook-token': API_TOKEN });
  const { data } = await fetchJson(`${server.baseUrl}/api/generation-jobs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ city: '杭州', guide: '柳浪闻莺和南宋御街', mode: 'deep', profileId: 'fallback-none' })
  });
  let job = data.job;
  for (let i = 0; i < 60 && job.status === 'running'; i += 1)
    job = (await fetchJson(`${server.baseUrl}/api/generation-jobs/${job.jobId}?after=${job.seq}`, { headers })).data.job;
  assert.equal(job.status, 'failed');
  assert.ok(calls.length >= 1 && calls.every((model) => model === 'deep-model-y'), JSON.stringify(calls));
  assert.equal(job.error.fallbackTried, undefined);
  assert.equal(job.error.suggestFast, true, 'the user can still choose 「用轻快重试」');
});

test('AI_MODEL_FALLBACK_ORDER with an unknown value refuses to start', async () => {
  await assert.rejects(startServer({ env: { AI_MODEL_FALLBACK_ORDER: 'fats' } }));
});

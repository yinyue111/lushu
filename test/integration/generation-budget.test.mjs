import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { API_TOKEN, fetchJson, jsonHeaders, startServer } from '../helpers/server.mjs';

// AI_TIMEOUT_MS is the budget for the whole generation, AI_CALL_TIMEOUT_MS for one model request.
// Several slow model requests in a row must not stretch a generation past the budget, a truncation
// retry is skipped when it cannot finish in time, and a relay that rejects json_schema is only
// asked with json_schema once.
let server;
let provider;
/** @type {{ format: string, maxTokens: number, at: number }[]} */
let requests = [];
const generated = {
  title: '杭州预算测试',
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
const ok = { output_text: JSON.stringify(generated), usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };

before(async () => {
  provider = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const format = body.text?.format?.type ?? 'none';
    requests.push({ format, maxTokens: body.max_output_tokens, at: Date.now() });
    const guide = JSON.stringify(body.input);
    const send = (status, data, delay) =>
      setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      }, delay);
    if (guide.includes('NOSCHEMA') && format === 'json_schema')
      return send(400, { error: { message: 'json_schema is not supported', code: 'bad_format' } }, 10);
    if (guide.includes('TRUNCATE'))
      return send(
        200,
        { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
        1500
      );
    if (guide.includes('HANG')) return send(200, ok, 20000);
    return send(200, ok, 50);
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = /** @type {import('node:net').AddressInfo} */ (provider.address());
  server = await startServer({
    env: {
      OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      AI_TIMEOUT_MS: '2500',
      AI_CALL_TIMEOUT_MS: '20000',
      GENERATION_DEDUP_TTL_MS: '0',
      GENERATION_QUOTA_PER_PROFILE: '50',
      GENERATION_JOB_POLL_WAIT_MS: '1000'
    }
  });
});
after(async () => {
  await server?.stop();
  provider?.closeAllConnections();
  await new Promise((resolve) => provider?.close(() => resolve(undefined)));
});

const headers = () => jsonHeaders({ 'x-routebook-token': API_TOKEN });
async function runJob(guide) {
  requests = [];
  const startedAt = Date.now();
  const { status, data } = await fetchJson(`${server.baseUrl}/api/generation-jobs`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ city: '杭州', guide })
  });
  assert.equal(status, 202, JSON.stringify(data));
  let seq = data.job.seq;
  for (let i = 0; i < 60; i += 1) {
    const polled = await fetchJson(`${server.baseUrl}/api/generation-jobs/${data.job.jobId}?after=${seq}`, { headers: headers() });
    seq = polled.data.job.seq;
    if (polled.data.job.status !== 'running') return { job: polled.data.job, elapsedMs: Date.now() - startedAt };
  }
  throw new Error('job never finished');
}

test('the whole generation stops at AI_TIMEOUT_MS even when one call may run longer', async () => {
  const { job, elapsedMs } = await runJob('HANG 柳浪闻莺和南宋御街');
  assert.equal(job.status, 'failed');
  assert.equal(job.error.code, 'MODEL_TIMEOUT');
  assert.match(job.error.message, /超时|自动停止/);
  assert.ok(elapsedMs < 6000, `stopped at the 2.5 s budget, not the 20 s call timeout (took ${elapsedMs} ms)`);
});

test('a truncation retry that cannot fit the remaining budget is not started', async () => {
  const { job, elapsedMs } = await runJob('TRUNCATE 柳浪闻莺和南宋御街');
  assert.equal(job.status, 'failed');
  assert.equal(job.error.code, 'MODEL_OUTPUT_TRUNCATED');
  assert.equal(requests.length, 1, 'only the first (truncated) request went out');
  assert.ok(elapsedMs < 2500, `failed right after the truncated call (took ${elapsedMs} ms)`);
});

test('a relay without json_schema support is asked with json_schema only once', async () => {
  const first = await runJob('NOSCHEMA 柳浪闻莺和南宋御街 第一次');
  assert.equal(first.job.status, 'succeeded', JSON.stringify(first.job.error));
  assert.deepEqual(
    requests.map((request) => request.format),
    ['json_schema', 'json_object']
  );
  const second = await runJob('NOSCHEMA 柳浪闻莺和南宋御街 第二次');
  assert.equal(second.job.status, 'succeeded', JSON.stringify(second.job.error));
  assert.deepEqual(
    requests.map((request) => request.format),
    ['json_object'],
    'the second generation goes straight to the format that worked'
  );
});

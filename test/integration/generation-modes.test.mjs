import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { API_TOKEN, fetchJson, jsonHeaders, startServer } from '../helpers/server.mjs';

// 轻快 / 细品 generation modes over a streaming (SSE) chat_completions relay: each mode uses its own
// model, the mode and model are recorded on the routebook, a stalled stream is stopped by the idle
// timeout, a truncated stream (finish_reason=length) is reported, and only a failed 轻快 run
// suggests 细品 (nothing escalates by itself).
let server;
let provider;
/** @type {{ model: string, stream: boolean }[]} */
let requests = [];
const generated = {
  title: '杭州模式测试',
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
    requests.push({ model: body.model, stream: body.stream === true, ...(body.reasoning_effort ? { effort: body.reasoning_effort } : {}) });
    const prompt = JSON.stringify(body.messages);
    const text = JSON.stringify(
      prompt.includes('FABRICATE')
        ? {
            ...generated,
            stops: generated.stops.map((stop, index) =>
              index === 0
                ? { ...stop, name: '柳浪闻莺（湖滨总店）', cost: '门票 45 元', verify: '南山路12号，营业时间 08:00-17:30', risk: '电话 0571-87065871' }
                : stop
            ),
            riskNotes: ['10月1日起需预约，人均约 120 元']
          }
        : generated
    );
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(
        JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
      );
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const event = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    const half = Math.floor(text.length / 2);
    event({ choices: [{ delta: { content: text.slice(0, half) } }] });
    if (prompt.includes('STALL')) return; // never finishes: the idle timeout has to stop it
    if (prompt.includes('CUTOFF')) {
      event({ choices: [{ delta: {}, finish_reason: 'length' }] });
      return res.end('data: [DONE]\n\n');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    event({ choices: [{ delta: { content: text.slice(half) } }] });
    event({ choices: [{ delta: {}, finish_reason: 'stop' }] });
    event({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } });
    res.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = /** @type {import('node:net').AddressInfo} */ (provider.address());
  server = await startServer({
    env: {
      OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      OPENAI_WIRE_API: 'chat_completions',
      AI_MODEL_FAST: 'fast-model-x',
      AI_MODEL_DEEP: 'deep-model-y',
      AI_STREAM: 'true',
      AI_STREAM_IDLE_MS_FAST: '1000',
      AI_STREAM_IDLE_MS_DEEP: '1000',
      AI_TIMEOUT_MS_FAST: '20000',
      AI_TIMEOUT_MS_DEEP: '20000',
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
async function runJob(guide, mode) {
  requests = [];
  const startedAt = Date.now();
  const { status, data } = await fetchJson(`${server.baseUrl}/api/generation-jobs`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ city: '杭州', guide, ...(mode ? { mode } : {}) })
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

test('轻快 is the default: streams from the fast model and records mode + model on the routebook', async () => {
  const { job } = await runJob('柳浪闻莺和南宋御街，默认模式');
  assert.equal(job.status, 'succeeded', JSON.stringify(job.error));
  assert.equal(job.mode, 'fast');
  assert.deepEqual(requests, [{ model: 'fast-model-x', stream: true }]);
  assert.equal(job.result.provider.mode, 'fast', 'the stored routebook (normalized for storage) keeps the mode');
  assert.equal(job.result.provider.model, 'fast-model-x');
  assert.equal(job.result.stops.length, 3);
});

test('细品 uses the deep model', async () => {
  const { job } = await runJob('柳浪闻莺和南宋御街，细品', 'deep');
  assert.equal(job.status, 'succeeded', JSON.stringify(job.error));
  assert.equal(job.mode, 'deep');
  assert.deepEqual(requests, [{ model: 'deep-model-y', stream: true, effort: 'xhigh' }], '细品 sends reasoning_effort=xhigh by default; 轻快 sends none');
  assert.equal(job.result.provider.mode, 'deep');
});

test('a stream that stops sending is cut by the idle timeout, and 轻快 suggests 细品', async () => {
  const { job, elapsedMs } = await runJob('STALL 柳浪闻莺', 'fast');
  assert.equal(job.status, 'failed');
  assert.equal(job.error.code, 'MODEL_STALLED');
  assert.equal(job.error.suggestDeep, true);
  assert.ok(elapsedMs < 8000, `stopped after ~1 s of silence, not the 20 s budget (took ${elapsedMs} ms)`);
  assert.equal(requests.length, 1, 'no silent retry or escalation');
});

test('a failed 细品 run does not suggest anything else', async () => {
  const { job } = await runJob('STALL 柳浪闻莺 细品', 'deep');
  assert.equal(job.error.code, 'MODEL_STALLED');
  assert.equal(job.error.suggestDeep, false);
});

test('finish_reason=length on a stream is reported as truncated output', async () => {
  const { job } = await runJob('CUTOFF 柳浪闻莺', 'fast');
  assert.equal(job.status, 'failed');
  assert.equal(job.error.code, 'MODEL_OUTPUT_TRUNCATED');
});

test('an unknown mode falls back to the default', async () => {
  const { job } = await runJob('柳浪闻莺和南宋御街，未知模式', 'turbo');
  assert.equal(job.mode, 'fast');
});

test('fabricated branches, addresses, prices, hours, phones and dates never reach the saved routebook', async () => {
  const { job } = await runJob('FABRICATE 柳浪闻莺、南宋御街、北山街', 'fast');
  assert.equal(job.status, 'succeeded', JSON.stringify(job.error));
  const saved = JSON.stringify(job.result);
  assert.doesNotMatch(saved, /湖滨总店|45 元|南山路12号|08:00-17:30|87065871|10月1日|120 元/);
  const stop = job.result.stops[0];
  assert.equal(stop.name, '柳浪闻莺');
  assert.equal(stop.cost, '价格待确认');
  assert.match(stop.verify, /地址待确认.*营业时间待确认/);
  assert.ok(
    job.result.aiNotes.some((note) => note.label === '具体信息待确认'),
    'the user is told what was hidden'
  );
});

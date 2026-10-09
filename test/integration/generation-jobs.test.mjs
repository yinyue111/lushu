import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { after, before, test } from 'node:test';
import { API_TOKEN, PROJECT_ROOT, adminHeaders, fetchJson, jsonHeaders, startServer } from '../helpers/server.mjs';
import { hermeticServerEnv } from '../../scripts/lib/hermetic-env.mjs';

// Async generation jobs against a mock model: staged progress, long-poll, cancel
// (aborts the upstream request), dedup, active-job limit and model timeout.
let server;
let provider;
let calls = 0;
const upstreamAborts = [];
const generated = {
  title: '杭州任务测试',
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
    let body = '';
    for await (const chunk of req) body += chunk;
    calls += 1;
    const slow = body.includes('SLOW');
    let closed = false;
    res.on('close', () => {
      if (!res.writableEnded) {
        closed = true;
        upstreamAborts.push({ at: Date.now(), slow });
      }
    });
    await new Promise((resolve) => setTimeout(resolve, slow ? 8000 : 300));
    if (closed) return;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ output_text: JSON.stringify(generated), usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }));
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const address = /** @type {import('node:net').AddressInfo} */ (provider.address());
  server = await startServer({
    env: {
      OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      AI_TIMEOUT_MS: '4000',
      GENERATION_DEDUP_TTL_MS: '600000',
      GENERATION_QUOTA_PER_PROFILE: '1',
      GENERATION_MAX_ACTIVE_JOBS: '2',
      GENERATION_JOB_POLL_WAIT_MS: '3000'
    }
  });
});
after(async () => {
  await server?.stop();
  provider?.closeAllConnections();
  await new Promise((resolve) => provider?.close(resolve));
});

const headers = (extra = {}) => jsonHeaders({ 'x-routebook-token': API_TOKEN, ...extra });
const startJob = (guide, extra = {}, extraHeaders = {}) =>
  fetchJson(`${server.baseUrl}/api/generation-jobs`, {
    method: 'POST',
    headers: headers(extraHeaders),
    body: JSON.stringify({ city: '杭州', guide, ...extra })
  });
const poll = (jobId, after, extraHeaders = {}) =>
  fetchJson(`${server.baseUrl}/api/generation-jobs/${jobId}${after == null ? '' : `?after=${after}`}`, { headers: headers(extraHeaders) });

async function waitUntil(jobId, predicate, extraHeaders = {}) {
  let seq = 0;
  const seen = [];
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const { status, data } = await poll(jobId, seq, extraHeaders);
    assert.equal(status, 200, JSON.stringify(data));
    seen.push(data.job);
    seq = data.job.seq;
    if (predicate(data.job)) return { job: data.job, seen };
  }
  throw new Error(`job ${jobId} never reached the expected state`);
}

test('a job returns at once and reports real stages until the saved routebook', async () => {
  const started = Date.now();
  const { status, data } = await startJob('柳浪闻莺和南宋御街，任务测试');
  assert.equal(status, 202, JSON.stringify(data));
  assert.ok(Date.now() - started < 1500, 'the POST does not wait for the model');
  assert.match(data.job.jobId, /^gen_[a-f0-9]{32}$/);
  assert.equal(data.job.status, 'running');
  assert.deepEqual(
    data.job.stages.map((stage) => stage.label),
    ['解析攻略', '匹配地点', '模型生成', '地点定位', '道路核验', '保存路书']
  );
  assert.equal(data.job.stages[0].status, 'completed', 'parsing finished when the job was accepted');
  assert.ok(data.job.timeoutMs >= 4000);
  assert.equal(data.job.estimate.typicalRange, '2–3 分钟');
  const { job, seen } = await waitUntil(data.job.jobId, (current) => current.status !== 'running');
  assert.equal(job.status, 'succeeded', JSON.stringify(job.error));
  assert.ok(
    seen.some((snapshot) => snapshot.stage === 'model' && snapshot.status === 'running'),
    'the model stage was observed while running'
  );
  assert.ok(job.stages.every((stage) => stage.status === 'completed'));
  assert.match(job.stages.find((stage) => stage.key === 'model').detail, /返回 3 个站点/);
  assert.ok(job.result.publicId, 'the result is the stored routebook');
  assert.ok(job.result.editToken, 'the owner gets the edit token');
  // A reload re-reads the finished job (no second model call).
  const reread = await poll(data.job.jobId);
  assert.equal(reread.data.job.result.publicId, job.result.publicId);
});

test('identical input joins the running job instead of calling the model again', async () => {
  const before = calls;
  const [first, second] = await Promise.all([startJob('北山街与南宋御街，重复测试'), startJob('北山街与南宋御街，重复测试')]);
  const ids = new Set([first.data.job.jobId, second.data.job.jobId]);
  assert.equal(ids.size, 1);
  await waitUntil(first.data.job.jobId, (job) => job.status === 'succeeded');
  const third = await startJob('北山街与南宋御街，重复测试 ');
  assert.equal(third.status, 200);
  assert.equal(third.data.deduplicated, true);
  assert.equal(third.data.job.result.publicId !== undefined, true);
  assert.equal(calls - before, 1);
});

test('cancel aborts the upstream model request, frees the slot and the quota', async () => {
  const registration = await fetchJson(`${server.baseUrl}/api/profile`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ creatorName: '取消' })
  });
  const profile = registration.data.profile;
  const owner = { 'x-routebook-profile-id': profile.id, 'x-routebook-profile-token': profile.profileAccessToken };
  const { data } = await startJob('SLOW 柳浪闻莺，取消测试', { profileId: profile.id }, owner);
  const jobId = data.job.jobId;
  await waitUntil(jobId, (job) => job.stage === 'model', owner);
  // Another client cannot read or cancel a registered profile's job.
  assert.equal((await poll(jobId)).status, 404);
  const abortsBefore = upstreamAborts.length;
  const cancelledAt = Date.now();
  const cancelled = await fetchJson(`${server.baseUrl}/api/generation-jobs/${jobId}/cancel`, { method: 'POST', headers: headers(owner) });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.data.job.status, 'cancelled');
  assert.equal(cancelled.data.job.stages.find((stage) => stage.key === 'model').status, 'cancelled');
  for (let i = 0; i < 40 && upstreamAborts.length === abortsBefore; i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(upstreamAborts.length, abortsBefore + 1, 'the provider saw the connection close');
  assert.ok(upstreamAborts.at(-1).at - cancelledAt < 2000);
  // The AI log records the cancellation, and the quota (1 per profile) is still free.
  let row;
  for (let i = 0; i < 20 && !row; i += 1) {
    const logs = await fetchJson(`${server.baseUrl}/api/logs?limit=20`, { headers: adminHeaders() });
    row = logs.data.logs.find((item) => item.jobId === jobId);
    if (!row) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(row.status, 'cancelled');
  assert.equal(row.upstreamAborted, true);
  assert.equal(row.cancelledDuringStage, 'model');
  const next = await startJob('南宋御街，取消后再生成', { profileId: profile.id }, owner);
  assert.equal(next.status, 202, JSON.stringify(next.data));
  const done = await waitUntil(next.data.job.jobId, (job) => job.status !== 'running', owner);
  assert.equal(done.job.status, 'succeeded');
  const overQuota = await startJob('北山街，第二次计费生成', { profileId: profile.id }, owner);
  assert.equal(overQuota.status, 429);
  assert.equal(overQuota.data.code, 'GENERATION_QUOTA_EXCEEDED');
});

test('a client can run at most GENERATION_MAX_ACTIVE_JOBS jobs at once', async () => {
  const first = await startJob('SLOW 并发一');
  const second = await startJob('SLOW 并发二');
  const third = await startJob('SLOW 并发三');
  assert.equal(first.status, 202);
  assert.equal(second.status, 202);
  assert.equal(third.status, 429);
  assert.equal(third.data.code, 'GENERATION_JOBS_BUSY');
  await fetchJson(`${server.baseUrl}/api/generation-jobs/${first.data.job.jobId}/cancel`, { method: 'POST', headers: headers() });
  const retry = await startJob('SLOW 并发三');
  assert.equal(retry.status, 202, 'cancelling freed a slot');
  for (const job of [second.data.job, retry.data.job]) {
    await fetchJson(`${server.baseUrl}/api/generation-jobs/${job.jobId}/cancel`, { method: 'POST', headers: headers() });
  }
});

test('a model that exceeds AI_TIMEOUT_MS fails the job with a readable timeout error', async () => {
  const { data } = await startJob('SLOW 超时测试');
  const { job } = await waitUntil(data.job.jobId, (current) => current.status !== 'running');
  assert.equal(job.status, 'failed');
  assert.equal(job.error.code, 'MODEL_TIMEOUT');
  assert.equal(job.error.stage, 'model');
  assert.match(job.error.message, /超时/);
});

test('unknown and malformed job ids are 404', async () => {
  for (const id of ['gen_' + '0'.repeat(32), 'nope']) {
    const response = await poll(id);
    assert.equal(response.status, 404);
    assert.equal(response.data.code, 'GENERATION_JOB_NOT_FOUND');
  }
});

test('timeouts default to a real model budget and the request timeout outlives it', () => {
  /** @type {Record<string, string>} */
  const env = hermeticServerEnv({});
  delete env.AI_TIMEOUT_MS;
  delete env.REQUEST_TIMEOUT_MS;
  const script = "const c = await import('./server/config/index.mjs'); console.log(JSON.stringify({ ai: c.AI_TIMEOUT_MS, request: c.REQUEST_TIMEOUT_MS }));";
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: PROJECT_ROOT, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const { ai, request } = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.ok(ai >= 240000, `AI_TIMEOUT_MS default ${ai}`);
  assert.ok(request > ai + 30000, `REQUEST_TIMEOUT_MS ${request} must outlive the model call`);
});

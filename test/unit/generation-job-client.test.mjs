import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clearActiveGenerationJob,
  followGenerationJob,
  formatDuration,
  generationEtaText,
  generationFailureCopy,
  readActiveGenerationJob,
  saveActiveGenerationJob
} from '../../src/lib/generationJob.js';

function memoryStorage() {
  const map = new Map();
  return { getItem: (key) => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)), removeItem: (key) => map.delete(key) };
}

const jobId = `gen_${'a'.repeat(32)}`;

test('the active job survives a reload and expires with the server retention', () => {
  const storage = memoryStorage();
  const startedAt = new Date('2026-10-09T10:00:00Z').toISOString();
  saveActiveGenerationJob({ jobId, profileId: 'p1', city: '成都', startedAt }, storage);
  assert.equal(readActiveGenerationJob(Date.parse(startedAt) + 60000, storage)?.jobId, jobId);
  assert.equal(readActiveGenerationJob(Date.parse(startedAt) + 31 * 60000, storage), null);
  saveActiveGenerationJob({ jobId, startedAt }, storage);
  clearActiveGenerationJob(`gen_${'b'.repeat(32)}`, storage);
  assert.ok(readActiveGenerationJob(Date.parse(startedAt), storage), 'clearing another job keeps this one');
  clearActiveGenerationJob(jobId, storage);
  assert.equal(readActiveGenerationJob(Date.parse(startedAt), storage), null);
});

test('followGenerationJob long-polls by seq, retries network errors and stops at a terminal state', async () => {
  const calls = [];
  const responses = [
    { job: { seq: 2, status: 'running', stage: 'model' } },
    new Error('network'),
    { job: { seq: 5, status: 'running', stage: 'geocode' } },
    { job: { seq: 7, status: 'succeeded', stage: 'done', result: { publicId: 'r1' } } }
  ];
  const updates = [];
  const final = await followGenerationJob(jobId, {
    after: 1,
    onUpdate: (job) => updates.push(job.stage),
    sleep: async () => {},
    fetchJob: async (_id, options) => {
      calls.push(options.after);
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    }
  });
  assert.equal(final.status, 'succeeded');
  assert.deepEqual(calls, [1, 2, 2, 5]);
  assert.deepEqual(updates, ['model', 'geocode', 'done']);
});

test('a job the server no longer knows surfaces as an error instead of polling forever', async () => {
  const error = Object.assign(new Error('gone'), { status: 404, code: 'GENERATION_JOB_NOT_FOUND' });
  await assert.rejects(
    followGenerationJob(jobId, {
      sleep: async () => {},
      fetchJob: async () => {
        throw error;
      }
    }),
    /gone/
  );
  assert.match(generationFailureCopy(error).title, /任务已失效/);
});

test('wait copy is honest: typical range, recent median and slower-than-usual', () => {
  assert.equal(formatDuration(12000), '12 秒');
  assert.equal(formatDuration(147000), '2 分 27 秒');
  const noSamples = generationEtaText({ estimate: { typicalRange: '2–3 分钟', sampleSize: 1, p50Ms: null }, timeoutMs: 300000 }, 10000);
  assert.equal(noSamples.typical, '通常需要 2–3 分钟');
  assert.match(noSamples.remaining, /预计还需约 2 分钟/);
  const withSamples = generationEtaText({ estimate: { typicalRange: '2–3 分钟', sampleSize: 4, p50Ms: 147000 }, timeoutMs: 300000 }, 100000);
  assert.match(withSamples.typical, /最近 4 次中位数 2 分 27 秒/);
  assert.equal(withSamples.remaining, '预计还需 1 分钟左右');
  const slow = generationEtaText({ estimate: { sampleSize: 4, p50Ms: 147000 }, timeoutMs: 300000 }, 200000);
  assert.match(slow.remaining, /超过 5 分钟会自动停止/);
});

test('failure copy is specific for timeouts, access codes and quota', () => {
  assert.match(generationFailureCopy({ code: 'MODEL_TIMEOUT' }).detail, /自动停止/);
  assert.match(generationFailureCopy({ code: 'LOCAL_ONLY' }).title, /访问码/);
  assert.match(generationFailureCopy({ code: 'GENERATION_QUOTA_EXCEEDED', message: '生成次数已达上限' }).detail, /上限/);
  assert.equal(generationFailureCopy({ message: '别的错误' }).detail, '别的错误');
});

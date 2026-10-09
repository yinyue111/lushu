// Async routebook generation jobs.
//
// POST /api/generation-jobs starts a job and returns at once; the browser polls
// GET /api/generation-jobs/:id (long-poll with ?after=<seq>) instead of holding one
// HTTP request open for the 2–3 minutes a real model needs. A job survives a page
// reload (the client keeps the job id) and can be cancelled, which aborts the
// upstream model request and frees the client's active-job slot and quota.
//
// Stage changes are pushed by the backend code that does the work
// (generateAndStoreRoutebook → generateRoutebook); there are no timers here.
//
// Jobs live in this process's memory. A restart loses running jobs (the client
// shows "任务已失效，请重新生成"); with several instances, polling must reach the
// instance that owns the job (sticky routing) — the default deployment is one instance.
import { randomBytes } from 'node:crypto';
import { createHttpError } from '../lib/util.mjs';
import { GENERATION_DEDUP_TTL_MS, GENERATION_JOB_RETENTION_MS, GENERATION_MAX_ACTIVE_JOBS } from '../config/index.mjs';

export const GENERATION_STAGES = Object.freeze([
  { key: 'parse', label: '解析攻略' },
  { key: 'match', label: '匹配地点' },
  { key: 'model', label: '模型生成' },
  { key: 'geocode', label: '地点定位' },
  { key: 'route', label: '道路核验' },
  { key: 'save', label: '保存路书' }
]);
const STAGE_KEYS = new Set(GENERATION_STAGES.map((stage) => stage.key));
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const MAX_JOBS = 500;

/** @type {Map<string, any>} */
const jobs = new Map();
/** dedup key → job id (running jobs, and succeeded jobs within the dedup TTL) */
const keyIndex = new Map();

export function newGenerationJobId() {
  return `gen_${randomBytes(16).toString('hex')}`;
}

export function isValidGenerationJobId(value) {
  return /^gen_[a-f0-9]{32}$/.test(String(value ?? ''));
}

function sweep(nowMs) {
  for (const [id, job] of jobs) {
    if (TERMINAL.has(job.status) && job.expiresAt <= nowMs) {
      jobs.delete(id);
      if (keyIndex.get(job.dedupKey) === id) keyIndex.delete(job.dedupKey);
    }
  }
  if (jobs.size <= MAX_JOBS) return;
  for (const [id, job] of jobs) {
    if (jobs.size <= MAX_JOBS) break;
    if (!TERMINAL.has(job.status)) continue;
    jobs.delete(id);
    if (keyIndex.get(job.dedupKey) === id) keyIndex.delete(job.dedupKey);
  }
}

function touch(job) {
  job.seq += 1;
  job.updatedAt = Date.now();
  const waiters = [...job.waiters];
  job.waiters.clear();
  for (const resolve of waiters) resolve();
}

function applyStageEvent(job, event) {
  if (TERMINAL.has(job.status) || !STAGE_KEYS.has(event?.stage)) return;
  const now = Date.now();
  const stage = job.stages[event.stage];
  if (event.state === 'started') {
    // Starting a later stage means every earlier one has finished.
    for (const { key } of GENERATION_STAGES) {
      if (key === event.stage) break;
      const earlier = job.stages[key];
      if (earlier.status === 'running' || earlier.status === 'pending') {
        earlier.status = 'completed';
        earlier.completedAt ??= now;
      }
    }
    if (stage.status !== 'running') {
      stage.status = 'running';
      stage.startedAt = now;
    }
    if (event.progress) stage.progress = { done: Number(event.progress.done) || 0, total: Number(event.progress.total) || 0 };
    if (event.detail) stage.detail = String(event.detail).slice(0, 80);
    job.stage = event.stage;
  } else if (event.state === 'completed') {
    stage.status = 'completed';
    stage.startedAt ??= now;
    stage.completedAt = now;
    if (event.detail) stage.detail = String(event.detail).slice(0, 80);
  }
  touch(job);
}

/** Look up a running (or recently succeeded) job for the same input. */
export function findDuplicateGenerationJob(dedupKey, nowMs = Date.now()) {
  sweep(nowMs);
  const id = dedupKey ? keyIndex.get(dedupKey) : '';
  const job = id ? jobs.get(id) : null;
  if (!job) return null;
  if (job.status === 'running') return job;
  if (job.status === 'succeeded' && job.dedupExpiresAt > nowMs) return job;
  return null;
}

/**
 * @param {{
 *   dedupKey: string,
 *   clientKey: string,
 *   profileId: string,
 *   estimate?: any,
 *   timeoutMs: number,
 *   parseDetail?: string,
 *   run: (signal: AbortSignal, onStage: (event: any) => void, jobId: string) => Promise<any>
 * }} input
 */
export function startGenerationJob({ dedupKey, clientKey, profileId, estimate = null, timeoutMs, parseDetail = '', run }) {
  const nowMs = Date.now();
  const duplicate = findDuplicateGenerationJob(dedupKey, nowMs);
  if (duplicate) return { job: duplicate, deduplicated: true };
  const active = [...jobs.values()].filter((job) => job.status === 'running' && job.clientKey === clientKey).length;
  if (active >= GENERATION_MAX_ACTIVE_JOBS) {
    throw createHttpError(`已有 ${active} 份路书正在生成，请等它完成或取消后再试`, 429, 'GENERATION_JOBS_BUSY');
  }
  const controller = new AbortController();
  const id = newGenerationJobId();
  const job = {
    id,
    dedupKey,
    clientKey,
    profileId,
    status: 'running',
    stage: 'parse',
    stages: Object.fromEntries(
      GENERATION_STAGES.map(({ key }) => [key, { status: 'pending', startedAt: null, completedAt: null, detail: '', progress: null }])
    ),
    createdAt: nowMs,
    updatedAt: nowMs,
    finishedAt: null,
    cancelledAt: null,
    expiresAt: Number.POSITIVE_INFINITY,
    dedupExpiresAt: 0,
    seq: 0,
    estimate,
    timeoutMs,
    result: null,
    error: null,
    controller,
    waiters: new Set()
  };
  jobs.set(id, job);
  if (dedupKey) keyIndex.set(dedupKey, id);
  // The request was already validated and fenced when the job was created.
  applyStageEvent(job, { stage: 'parse', state: 'started' });
  applyStageEvent(job, { stage: 'parse', state: 'completed', detail: parseDetail });
  job.promise = Promise.resolve()
    .then(() => run(controller.signal, (event) => applyStageEvent(job, event), id))
    .then(
      (result) => {
        if (job.status !== 'running') return;
        for (const { key } of GENERATION_STAGES) {
          const stage = job.stages[key];
          if (stage.status !== 'completed') {
            stage.status = 'completed';
            stage.completedAt ??= Date.now();
          }
        }
        job.status = 'succeeded';
        job.stage = 'done';
        job.result = result;
        job.finishedAt = Date.now();
        job.expiresAt = job.finishedAt + Math.max(GENERATION_JOB_RETENTION_MS, GENERATION_DEDUP_TTL_MS);
        job.dedupExpiresAt = GENERATION_DEDUP_TTL_MS ? job.finishedAt + GENERATION_DEDUP_TTL_MS : 0;
        if (!job.dedupExpiresAt && keyIndex.get(dedupKey) === id) keyIndex.delete(dedupKey);
        touch(job);
      },
      (error) => {
        if (keyIndex.get(dedupKey) === id) keyIndex.delete(dedupKey);
        if (job.status !== 'running') return;
        job.status = 'failed';
        job.finishedAt = Date.now();
        job.expiresAt = job.finishedAt + GENERATION_JOB_RETENTION_MS;
        const stage = job.stages[job.stage];
        if (stage?.status === 'running') stage.status = 'failed';
        job.error = {
          message: String(error?.statusCode && error?.statusCode < 500 ? error.message : publicFailureMessage(error)).slice(0, 200),
          code: String(error?.code ?? 'MODEL_ERROR'),
          status: Number(error?.statusCode) || 502,
          stage: job.stage
        };
        touch(job);
      }
    );
  return { job, deduplicated: false };
}

function publicFailureMessage(error) {
  const message = String(error?.message ?? '');
  return /[\u4e00-\u9fa5]/.test(message) ? message : '生成失败，请稍后重试';
}

export function getGenerationJob(id) {
  sweep(Date.now());
  return isValidGenerationJobId(id) ? (jobs.get(id) ?? null) : null;
}

/** Cancels a running job: aborts the upstream model call and frees the slot. */
export function cancelGenerationJob(job) {
  if (!job || job.status !== 'running') return job;
  job.status = 'cancelled';
  job.cancelledAt = Date.now();
  job.finishedAt = job.cancelledAt;
  job.expiresAt = job.cancelledAt + GENERATION_JOB_RETENTION_MS;
  const stage = job.stages[job.stage];
  if (stage?.status === 'running') stage.status = 'cancelled';
  if (keyIndex.get(job.dedupKey) === job.id) keyIndex.delete(job.dedupKey);
  job.controller.abort();
  touch(job);
  return job;
}

/** Resolves when the job changes after `afterSeq`, or after waitMs. */
export function waitForGenerationJob(job, afterSeq, waitMs, signal) {
  if (!job || job.seq > afterSeq || TERMINAL.has(job.status) || waitMs <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      job.waiters.delete(done);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, waitMs);
    job.waiters.add(done);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** What the client sees. The result (with its edit token) is only in a succeeded job. */
export function generationJobSnapshot(job, nowMs = Date.now()) {
  return {
    jobId: job.id,
    status: job.status,
    stage: job.stage,
    seq: job.seq,
    stages: GENERATION_STAGES.map(({ key, label }) => ({ key, label, ...job.stages[key] })),
    createdAt: new Date(job.createdAt).toISOString(),
    elapsedMs: (job.finishedAt ?? nowMs) - job.createdAt,
    estimate: job.estimate,
    timeoutMs: job.timeoutMs,
    ...(job.status === 'cancelled' ? { cancelledAt: new Date(job.cancelledAt).toISOString() } : {}),
    ...(job.error ? { error: job.error } : {}),
    ...(job.status === 'succeeded' ? { result: job.result } : {})
  };
}

/** Test hook. */
export function resetGenerationJobs() {
  for (const job of jobs.values()) if (job.status === 'running') job.controller.abort();
  jobs.clear();
  keyIndex.clear();
}

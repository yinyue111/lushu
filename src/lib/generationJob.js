// Client side of async routebook generation (server: server/ai/generationJobs.mjs).
// Keeps the running job id in localStorage so a reload or leaving the builder
// resumes the same job instead of starting (and paying for) a new one.
import { cancelGenerationJob, getGenerationJob } from './api.js';

const ACTIVE_JOB_KEY = 'trusted-routebook:generation-job:v1';
// Matches the server's default retention for finished jobs.
const ACTIVE_JOB_MAX_AGE_MS = 30 * 60 * 1000;

export const GENERATION_STAGE_LABELS = Object.freeze({
  parse: '解析攻略',
  match: '匹配地点',
  model: '模型生成',
  geocode: '地点定位',
  route: '道路核验',
  save: '保存路书'
});

/** @typedef {Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>} JobStorage */

/**
 * @param {{ jobId: string, profileId?: string, city?: string, duration?: string, startedAt?: string }} job
 * @param {JobStorage | null} [storage]
 */
export function saveActiveGenerationJob(job, storage = safeLocalStorage()) {
  if (!storage || !job?.jobId) return;
  try {
    storage.setItem(ACTIVE_JOB_KEY, JSON.stringify({ ...job, startedAt: job.startedAt || new Date().toISOString() }));
  } catch {
    // Best effort: without storage the job still finishes, it just cannot be resumed.
  }
}

/** @param {JobStorage | null} [storage] */
export function readActiveGenerationJob(nowMs = Date.now(), storage = safeLocalStorage()) {
  if (!storage) return null;
  try {
    const job = JSON.parse(storage.getItem(ACTIVE_JOB_KEY) ?? 'null');
    if (!job || typeof job !== 'object' || !/^gen_[a-f0-9]{32}$/.test(String(job.jobId ?? ''))) return null;
    const startedAt = Date.parse(job.startedAt ?? '');
    if (!Number.isFinite(startedAt) || nowMs - startedAt > ACTIVE_JOB_MAX_AGE_MS) {
      storage.removeItem(ACTIVE_JOB_KEY);
      return null;
    }
    return job;
  } catch {
    return null;
  }
}

/** @param {JobStorage | null} [storage] */
export function clearActiveGenerationJob(jobId = '', storage = safeLocalStorage()) {
  if (!storage) return;
  try {
    const current = JSON.parse(storage.getItem(ACTIVE_JOB_KEY) ?? 'null');
    if (!jobId || current?.jobId === jobId) storage.removeItem(ACTIVE_JOB_KEY);
  } catch {
    storage.removeItem(ACTIVE_JOB_KEY);
  }
}

/** @returns {JobStorage | null} */
function safeLocalStorage() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

/**
 * Follows a job until it finishes. Network hiccups retry with backoff; a 404 means
 * the server no longer knows the job (restart / expiry) and is surfaced to the caller.
 * @param {string} jobId
 * @param {{ profileId?: string, after?: number, signal?: AbortSignal, onUpdate?: (job: any) => void, fetchJob?: (jobId: string, options: { after?: number, profileId?: string }, signal?: AbortSignal) => Promise<any>, sleep?: (ms: number) => Promise<void> }} options
 */
export async function followGenerationJob(
  jobId,
  { profileId, after = 0, signal, onUpdate = () => {}, fetchJob = getGenerationJob, sleep = defaultSleep } = {}
) {
  let seq = after;
  let failures = 0;
  for (;;) {
    if (signal?.aborted) throw abortError();
    let job;
    try {
      ({ job } = await fetchJob(jobId, { after: seq, profileId }, signal));
      failures = 0;
    } catch (error) {
      if (signal?.aborted) throw abortError();
      if (error?.status === 404 || error?.status === 403) throw error;
      failures += 1;
      if (failures > 20) throw error;
      await sleep(Math.min(10000, 1000 * 2 ** Math.min(failures, 4)));
      continue;
    }
    seq = job.seq;
    onUpdate(job);
    if (TERMINAL.has(job.status)) return job;
  }
}

export function cancelActiveGeneration(jobId, profileId) {
  return cancelGenerationJob(jobId, profileId);
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function abortError() {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

/** 1:05 / 12 秒 style elapsed time. */
export function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(Number(ms) / 1000) || 0);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`;
}

/**
 * Honest wait copy: the typical range, the recent median when the server has enough
 * samples, and what happens when this run is slower than usual.
 * @returns {{ typical: string, remaining: string }}
 */
export function generationEtaText(job, elapsedMs) {
  const estimate = job?.estimate ?? {};
  const p50 = Number(estimate.p50Ms) || 0;
  const timeoutMinutes = Math.round((Number(job?.timeoutMs) || 300000) / 60000);
  const typical =
    p50 && estimate.sampleSize >= 3
      ? `通常需要 ${estimate.typicalRange || '2–3 分钟'}（最近 ${estimate.sampleSize} 次中位数 ${formatDuration(p50)}）`
      : `通常需要 ${estimate.typicalRange || '2–3 分钟'}`;
  const reference = p50 || 150000;
  const left = reference - elapsedMs;
  let remaining;
  if (left > 90000) remaining = `预计还需约 ${Math.round(left / 60000)} 分钟`;
  else if (left > 20000) remaining = '预计还需 1 分钟左右';
  else if (left > 0) remaining = '快好了';
  else remaining = `比平时慢一些，仍在等待；超过 ${timeoutMinutes} 分钟会自动停止，不会一直卡住`;
  return { typical, remaining };
}

/** Friendly copy for a failed job / request error. */
export function generationFailureCopy(error) {
  const code = String(error?.code ?? '');
  switch (code) {
    case 'MODEL_TIMEOUT':
      return { title: '模型这次太慢了', detail: '模型服务在等待上限内没有返回结果，已自动停止。可以稍后再试，或减少天数和必去地点后重试。' };
    case 'MODEL_BAD_OUTPUT':
    case 'MODEL_OUTPUT_TRUNCATED':
    case 'MODEL_OUTPUT_INCOMPLETE':
      return { title: 'AI 返回的路书不完整', detail: '这次输出格式有问题，没有保存。重新生成通常就能恢复。' };
    case 'MODEL_NOT_READY':
    case 'MODEL_FETCH_FAILED':
      return { title: '模型服务暂时不可用', detail: '你的攻略和偏好都已保留，稍后再试即可。' };
    case 'GENERATION_QUOTA_EXCEEDED':
      return { title: '今天的生成次数用完了', detail: error?.message || '请稍后再试。' };
    case 'GENERATION_JOBS_BUSY':
      return { title: '已有路书正在生成', detail: error?.message || '请等它完成或取消后再试。' };
    case 'GENERATION_JOB_NOT_FOUND':
      return { title: '生成任务已失效', detail: '服务可能刚重启，这次的进度没有保留下来。你的攻略和偏好还在，重新生成即可。' };
    case 'LOCAL_ONLY':
      return { title: '需要平台访问码', detail: '这个部署只对持有访问码的用户开放生成。请在右上角「高级设置」填写访问码后重试。' };
    case 'RATE_LIMITED':
      return { title: '操作有点频繁', detail: '请稍等一分钟再试。' };
    default:
      return { title: '这次没能生成路书', detail: error?.message || '请稍后重试。' };
  }
}

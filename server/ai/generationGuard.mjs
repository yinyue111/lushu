// Phase 2: generation de-duplication and per-profile quota.
//
// - Identical requests (same profile + normalized input) share one in-flight
//   model call, and within GENERATION_DEDUP_TTL_MS reuse the previous response
//   instead of calling the model again. The cache is per process (in memory);
//   with several instances a duplicate may still reach the model once per instance.
// - Registered profiles get GENERATION_QUOTA_PER_PROFILE model generations per
//   rolling GENERATION_QUOTA_WINDOW_MS, counted from ai-logs (so it survives
//   restarts and is shared across instances). The shared 'anonymous' identity is
//   left to the per-IP 'ai' rate limit, otherwise one user could lock out everyone.
import { createHash } from 'node:crypto';
import {
  GENERATION_MODES,
  resolveGenerationMode,
  AI_LOG_PATH,
  GENERATION_DEDUP_TTL_MS,
  GENERATION_QUOTA_PER_PROFILE,
  GENERATION_QUOTA_DEEP_PER_PROFILE,
  GENERATION_QUOTA_PATCH_PER_PROFILE,
  GENERATION_QUOTA_WINDOW_MS,
  GENERATION_DAILY_LIMIT
} from '../config/index.mjs';
import { createHttpError } from '../lib/util.mjs';
import { readMatchingJsonLines } from '../storage/jsonl.mjs';

const MAX_CACHE_ENTRIES = 200;
const resultCache = new Map();
const inFlight = new Map();

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])])
    );
  }
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : value;
}

export function generationInputHash(payload) {
  // The mode and the model settings behind it are part of the key: 轻快 then 细品 on the same input must
  // be two separate generations, and an env change (model / reasoning effort) must not reuse old output.
  const mode = resolveGenerationMode(payload?.mode);
  const settings = GENERATION_MODES[mode];
  const input = {
    mode,
    model: settings.model || String(process.env.OPENAI_MODEL ?? ''),
    reasoningEffort: settings.reasoningEffort || '',
    profileId: payload?.profileId ?? '',
    city: payload?.city ?? '',
    guide: payload?.guide ?? '',
    constraints: payload?.constraints ?? {},
    sources: (payload?.importedSources ?? []).map((source) => [source?.url ?? '', source?.fetchedAt ?? '', source?.status ?? ''])
  };
  return createHash('sha256')
    .update(JSON.stringify(stable(input)))
    .digest('hex');
}

/**
 * Run `generate` unless an identical request is in flight or cached.
 * @template T
 * @param {any} payload
 * @param {() => Promise<T>} generate
 * @param {{ ttlMs?: number, nowMs?: number }} [options]
 * @returns {Promise<{ result: T, deduplicated: boolean }>}
 */
export async function withGenerationDedup(payload, generate, { ttlMs = GENERATION_DEDUP_TTL_MS, nowMs = Date.now() } = {}) {
  if (!ttlMs) return { result: await generate(), deduplicated: false };
  const key = generationInputHash(payload);
  const cached = resultCache.get(key);
  if (cached && cached.expiresAt > nowMs) return { result: cached.result, deduplicated: true };
  if (cached) resultCache.delete(key);
  const pending = inFlight.get(key);
  if (pending) return { result: await pending, deduplicated: true };
  const promise = generate();
  inFlight.set(key, promise);
  try {
    const result = await promise;
    resultCache.set(key, { result, expiresAt: Date.now() + ttlMs });
    while (resultCache.size > MAX_CACHE_ENTRIES) resultCache.delete(resultCache.keys().next().value);
    return { result, deduplicated: false };
  } finally {
    inFlight.delete(key);
  }
}

export function clearGenerationDedupCache() {
  resultCache.clear();
}

/**
 * How many generations this profile has left in the rolling window (does not throw).
 * Guests / anonymous are unlimited here (IP rate limit covers them).
 */
export async function peekGenerationQuota(
  profileId,
  {
    quota = GENERATION_QUOTA_PER_PROFILE,
    windowMs = GENERATION_QUOTA_WINDOW_MS,
    nowMs = Date.now(),
    mode = '',
    deepQuota = GENERATION_QUOTA_DEEP_PER_PROFILE
  } = {}
) {
  if (!profileId || profileId === 'anonymous') {
    return { limited: false, used: 0, quota: 0, remaining: null, windowHours: Math.round(windowMs / 3600000) || 1, retryAfterSeconds: 0 };
  }
  const windowHours = Math.round(windowMs / 3600000) || 1;
  if (mode === 'deep' && deepQuota > 0) {
    const since = nowMs - windowMs;
    const deepRows = await readMatchingJsonLines(
      AI_LOG_PATH,
      (row) =>
        row?.kind === 'generate-routebook' &&
        row?.profileId === profileId &&
        row?.mode === 'deep' &&
        row?.deduplicated !== true &&
        row?.status !== 'cancelled' &&
        Date.parse(row?.createdAt ?? '') >= since,
      deepQuota,
      50000
    );
    if (deepRows.length >= deepQuota) {
      const oldest = Math.min(...deepRows.map((row) => Date.parse(row.createdAt)));
      return {
        limited: true,
        used: deepRows.length,
        quota: deepQuota,
        remaining: 0,
        windowHours,
        retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - nowMs) / 1000)),
        kind: 'deep'
      };
    }
  }
  if (!quota) return { limited: false, used: 0, quota: 0, remaining: null, windowHours, retryAfterSeconds: 0 };
  const since = nowMs - windowMs;
  const rows = await readMatchingJsonLines(
    AI_LOG_PATH,
    (row) =>
      row?.kind === 'generate-routebook' &&
      row?.profileId === profileId &&
      row?.deduplicated !== true &&
      // A generation the user cancelled gives its quota back.
      row?.status !== 'cancelled' &&
      Date.parse(row?.createdAt ?? '') >= since,
    quota,
    50000
  );
  if (rows.length < quota) {
    return { limited: false, used: rows.length, quota, remaining: quota - rows.length, windowHours, retryAfterSeconds: 0 };
  }
  const oldest = Math.min(...rows.map((row) => Date.parse(row.createdAt)));
  return {
    limited: true,
    used: rows.length,
    quota,
    remaining: 0,
    windowHours,
    retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - nowMs) / 1000))
  };
}

/** 全站每日上限：所有人的整本生成 + 局部调整合计。 */
export async function peekDailyGenerationLimit({ limit = GENERATION_DAILY_LIMIT, nowMs = Date.now() } = {}) {
  if (!limit) return { limited: false, used: 0, limit: 0 };
  const since = nowMs - 86_400_000;
  const rows = await readMatchingJsonLines(
    AI_LOG_PATH,
    (row) =>
      (row?.kind === 'generate-routebook' || row?.kind === 'patch-routebook') &&
      row?.deduplicated !== true &&
      row?.status !== 'cancelled' &&
      Date.parse(row?.createdAt ?? '') >= since,
    limit,
    200000
  );
  return { limited: rows.length >= limit, used: rows.length, limit };
}

export async function enforceDailyGenerationLimit(options = {}) {
  const peek = await peekDailyGenerationLimit(options);
  if (!peek.limited) return peek;
  console.warn(`[generation] daily limit reached: ${peek.used}/${peek.limit} in 24h`);
  const error = createHttpError('今天的 AI 生成名额用完了，明天再来试试。已经生成的路书不受影响。', 429, 'GENERATION_DAILY_LIMIT');
  /** @type {any} */ (error).retryAfterSeconds = 3600;
  throw error;
}

/** Throws 429 GENERATION_QUOTA_EXCEEDED when the profile used its window quota. */
export async function enforceGenerationQuota(profileId, options = {}) {
  await enforceDailyGenerationLimit(options.daily);
  const peek = await peekGenerationQuota(profileId, options);
  if (!peek.limited) return peek;
  const message =
    peek.kind === 'deep'
      ? `「细品」次数已达上限（每 ${peek.windowHours} 小时 ${peek.quota} 次），可以先用「轻快」`
      : `生成次数已达上限（每 ${peek.windowHours} 小时 ${peek.quota} 次），请稍后再试`;
  const error = createHttpError(message, 429, 'GENERATION_QUOTA_EXCEEDED');
  /** @type {any} */ (error).retryAfterSeconds = peek.retryAfterSeconds;
  throw error;
}


/** Patch (L2) quota: defaults to 2× full generation quota when GENERATION_QUOTA_PATCH_PER_PROFILE is 0. */
export async function peekPatchQuota(profileId, { quota, windowMs = GENERATION_QUOTA_WINDOW_MS, nowMs = Date.now() } = {}) {
  const effective =
    Number.isInteger(quota) && quota > 0
      ? quota
      : GENERATION_QUOTA_PATCH_PER_PROFILE > 0
        ? GENERATION_QUOTA_PATCH_PER_PROFILE
        : Math.max(1, (GENERATION_QUOTA_PER_PROFILE || 30) * 2);
  if (!profileId || profileId === 'anonymous') {
    return { limited: false, used: 0, quota: 0, remaining: null, windowHours: Math.round(windowMs / 3600000) || 1, kind: 'patch' };
  }
  const windowHours = Math.round(windowMs / 3600000) || 1;
  const since = nowMs - windowMs;
  const rows = await readMatchingJsonLines(
    AI_LOG_PATH,
    (row) =>
      row?.kind === 'patch-routebook' &&
      row?.profileId === profileId &&
      row?.deduplicated !== true &&
      row?.status !== 'cancelled' &&
      Date.parse(row?.createdAt ?? '') >= since,
    effective,
    50000
  );
  if (rows.length < effective) {
    return { limited: false, used: rows.length, quota: effective, remaining: effective - rows.length, windowHours, kind: 'patch', retryAfterSeconds: 0 };
  }
  const oldest = Math.min(...rows.map((row) => Date.parse(row.createdAt)));
  return {
    limited: true,
    used: rows.length,
    quota: effective,
    remaining: 0,
    windowHours,
    kind: 'patch',
    retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - nowMs) / 1000))
  };
}

export async function enforcePatchQuota(profileId, options = {}) {
  await enforceDailyGenerationLimit(options.daily);
  const peek = await peekPatchQuota(profileId, options);
  if (!peek.limited) return peek;
  const error = createHttpError(
    `局部调整次数已达上限（每 ${peek.windowHours} 小时 ${peek.quota} 次），可先用手动编辑或不耗次数的一键调整`,
    429,
    'PATCH_QUOTA_EXCEEDED'
  );
  /** @type {any} */ (error).retryAfterSeconds = peek.retryAfterSeconds;
  throw error;
}

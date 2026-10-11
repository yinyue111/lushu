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
  GENERATION_QUOTA_WINDOW_MS
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

/** Throws 429 GENERATION_QUOTA_EXCEEDED when the profile used its window quota. */
export async function enforceGenerationQuota(
  profileId,
  {
    quota = GENERATION_QUOTA_PER_PROFILE,
    windowMs = GENERATION_QUOTA_WINDOW_MS,
    nowMs = Date.now(),
    mode = '',
    deepQuota = GENERATION_QUOTA_DEEP_PER_PROFILE
  } = {}
) {
  if (!profileId || profileId === 'anonymous') return { limited: false, used: 0, quota };
  // 细品 runs the slow, expensive model: an optional extra cap inside the shared quota.
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
      const error = createHttpError(
        `「细品」次数已达上限（每 ${Math.round(windowMs / 3600000) || 1} 小时 ${deepQuota} 次），可以先用「轻快」`,
        429,
        'GENERATION_QUOTA_EXCEEDED'
      );
      /** @type {any} */ (error).retryAfterSeconds = Math.max(1, Math.ceil((oldest + windowMs - nowMs) / 1000));
      throw error;
    }
  }
  if (!quota) return { limited: false, used: 0, quota };
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
  if (rows.length < quota) return { limited: false, used: rows.length, quota };
  const oldest = Math.min(...rows.map((row) => Date.parse(row.createdAt)));
  const retryAfterSeconds = Math.max(1, Math.ceil((oldest + windowMs - nowMs) / 1000));
  const error = createHttpError(`生成次数已达上限（每 ${Math.round(windowMs / 3600000) || 1} 小时 ${quota} 次），请稍后再试`, 429, 'GENERATION_QUOTA_EXCEEDED');
  /** @type {any} */ (error).retryAfterSeconds = retryAfterSeconds;
  throw error;
}

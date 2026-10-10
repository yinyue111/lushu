// One routebook generation: model call, geocoding, routing, persistence and the AI log row.
// Shared by the synchronous POST /api/generate-routebook and async generation jobs.
import { truncateString, hashText } from '../lib/util.mjs';
import { AI_LOG_PATH, GENERATION_DEFAULT_MODE, GENERATION_MODES, resolveGenerationMode } from '../config/index.mjs';
import { appendJsonLine, readJsonLines } from '../storage/jsonl.mjs';
import { createRouteEditToken, normalizeProfileId, sanitizeEditToken } from '../auth/tokens.mjs';
import { normalizeRoutebookForStorage } from '../routebooks/normalize.mjs';
import { generateRoutebook, generationFailureReason } from './generate.mjs';
import { enrichRoutebook } from '../trust/feedback.mjs';
import { appendVersionedRoutebook } from '../routebooks/versions.mjs';
import { normalizeUserRouteCreator } from '../routebooks/mutations.mjs';

export function guideLogMeta(payload) {
  const guide = String(payload?.guide ?? '');
  return {
    inputHash: hashText(guide),
    inputLength: guide.length,
    sourceCount: payload?.importedSources?.length ?? 0
  };
}

/**
 * @param {any} payload sanitized payload (see sanitizePayload) with the acting profileId
 * @param {{ signal?: AbortSignal, requestId: string, onStage?: (event: { stage: string, state: string, detail?: string, progress?: { done: number, total: number } }) => void, jobId?: string, deadline?: number }} options
 */
export async function generateAndStoreRoutebook(payload, { signal, requestId, onStage = () => {}, jobId = '', deadline = 0 }) {
  const startedAt = Date.now();
  const inputMeta = guideLogMeta(payload);
  let observability = null;
  let persistenceStartedAt = null;
  let persistenceCompleted = false;
  let activeProgressStage = 'match';
  const trackStage = (event) => {
    if (event?.state === 'started') activeProgressStage = event.stage;
    onStage(event);
  };
  try {
    const routebook = await generateRoutebook(payload, signal, { onStage: trackStage, deadline, mode: payload.mode });
    observability = routebook.observability;
    const profileId = normalizeProfileId(payload.profileId);
    activeProgressStage = 'save';
    onStage({ stage: 'save', state: 'started' });
    const storedRoutebook = normalizeRoutebookForStorage(
      {
        ...routebook,
        schemaVersion: 2,
        version: 1,
        parentVersion: null,
        changeReason: 'AI 生成初始草稿',
        actorType: 'user',
        profileId,
        creator: normalizeUserRouteCreator(payload, profileId),
        sourceAuthorization: 'user-generated',
        editToken: sanitizeEditToken(payload.editToken) || createRouteEditToken()
      },
      routebook.publicId
    );
    persistenceStartedAt = Date.now();
    await appendVersionedRoutebook(storedRoutebook, 'generated');
    persistenceCompleted = true;
    observability.stages.persistence = { durationMs: Date.now() - persistenceStartedAt, status: 'completed', timedOut: false };
    await appendJsonLine(AI_LOG_PATH, {
      requestId,
      ...(jobId ? { jobId } : {}),
      kind: 'generate-routebook',
      mode: resolveGenerationMode(payload.mode),
      status: 'ok',
      city: payload.city,
      profileId,
      provider: routebook.provider,
      ...inputMeta,
      ...observability,
      outputTitle: storedRoutebook.title,
      trustScore: storedRoutebook.trustScore,
      stopCount: storedRoutebook.stops.length,
      publicId: storedRoutebook.publicId,
      durationMs: Date.now() - startedAt,
      createdAt: new Date().toISOString()
    });
    onStage({ stage: 'save', state: 'completed', detail: '已保存为你的草稿' });
    return { ...(await enrichRoutebook(storedRoutebook)), shareUrl: '' };
  } catch (error) {
    observability = error.observability ?? observability;
    if (observability && persistenceStartedAt != null && !persistenceCompleted) {
      observability = {
        ...observability,
        failureStage: 'persistence',
        stages: { ...observability.stages, persistence: { durationMs: Date.now() - persistenceStartedAt, status: 'failed', timedOut: false } }
      };
    }
    const cancelled = error?.code === 'CLIENT_ABORTED' || Boolean(signal?.aborted && !/TIMEOUT/.test(String(error?.code)));
    await appendJsonLine(AI_LOG_PATH, {
      requestId,
      ...(jobId ? { jobId } : {}),
      kind: 'generate-routebook',
      mode: resolveGenerationMode(payload.mode),
      // Cancelled generations are logged for the record but do not count against quota.
      status: cancelled ? 'cancelled' : 'error',
      city: payload.city,
      profileId: normalizeProfileId(payload.profileId),
      ...inputMeta,
      ...(observability ?? {}),
      ...(cancelled ? { cancelledDuringStage: activeProgressStage, upstreamAborted: activeProgressStage === 'model' } : {}),
      code: cancelled ? 'CLIENT_ABORTED' : (error.code ?? 'MODEL_ERROR'),
      failureReason: cancelled ? 'client-aborted' : generationFailureReason(error),
      upstreamStatus: error.upstreamStatus,
      upstreamDetail: truncateString(error.upstreamDetail, 400),
      durationMs: Date.now() - startedAt,
      createdAt: new Date().toISOString()
    });
    throw error;
  }
}

/** @type {Map<string, { at: number, value: any }>} */
const estimateCache = new Map();
const ESTIMATE_CACHE_MS = 60 * 1000;

/**
 * Honest wait estimate from recent successful generations (P50 of total duration),
 * not a fixed guess. With fewer than 3 samples the client shows the typical range.
 * @param {any[]} [rows] newest-first AI log rows (test hook)
 */
export async function recentGenerationEstimate(rows, nowMs = Date.now(), mode = GENERATION_DEFAULT_MODE) {
  const modeKey = resolveGenerationMode(mode);
  const cached = estimateCache.get(modeKey);
  if (!rows && cached && nowMs - cached.at < ESTIMATE_CACHE_MS) return cached.value;
  const history = rows ?? (await readJsonLines(AI_LOG_PATH, 400).catch(() => []));
  // Rows logged before modes existed were all made by the deep (grok) model.
  const durations = history
    .filter((row) => row?.kind === 'generate-routebook' && row?.status === 'ok' && row?.deduplicated !== true && Number(row?.durationMs) > 0)
    .filter((row) => (row?.mode || 'deep') === modeKey)
    .slice(0, 30)
    .map((row) => Number(row.durationMs))
    .sort((left, right) => left - right);
  const [low, high] = GENERATION_MODES[modeKey].typicalSeconds;
  const value = {
    mode: modeKey,
    typicalRange: high <= 90 ? `${low}–${high} 秒` : `${Math.max(1, Math.round(low / 60))}–${Math.round(high / 60)} 分钟`,
    sampleSize: durations.length,
    p50Ms: durations.length >= 3 ? durations[Math.floor((durations.length - 1) / 2)] : null
  };
  if (!rows) estimateCache.set(modeKey, { at: nowMs, value });
  return value;
}

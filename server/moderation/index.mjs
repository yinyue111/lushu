// Moderation queue for public user content (check-in text, published routebooks).
// Rows in the moderation-queue stream (append-only, doubles as audit trail):
//   { type: 'moderation-item', entityType, entityId, profileId, status: pending|blocked, ... }
//   { type: 'moderation-decision', entityType, entityId, profileId, action: approve|reject, reason, actor }
// The latest row per entity decides visibility: pending / blocked / rejected are withheld
// from public views; approved (or never flagged) is shown. Legacy content has no rows and
// therefore stays visible, so existing data is unaffected.
import {
  MODERATION_API_KEY,
  MODERATION_API_URL,
  MODERATION_KEYWORDS_FILE,
  MODERATION_PROVIDER,
  MODERATION_QUEUE_LOG_PATH,
  MODERATION_TIMEOUT_MS
} from '../config/index.mjs';
import { appendJsonLine, onJsonlAppend, readJsonLines } from '../storage/jsonl.mjs';
import { withStorageEntityLock } from '../storage/runtime.mjs';
import { cryptoRandomId } from '../auth/tokens.mjs';
import { createHttpError, sanitizePublicId, truncateString } from '../lib/util.mjs';
import { opsActorForRequest, validateOpsAuditInput } from '../ops/audit.mjs';
import { keywordPrefilter, loadKeywordFile } from './filters.mjs';
import { createDomesticModerationAdapter, strictestDecision } from './providers.mjs';

export const MODERATION_ENTITY_TYPES = Object.freeze(['checkin', 'routebook']);
const WITHHELD_STATUSES = new Set(['pending', 'blocked', 'rejected']);
const STATE_TTL_MS = 2000;

let keywordCache = null;
function keywords() {
  if (!keywordCache) keywordCache = loadKeywordFile(MODERATION_KEYWORDS_FILE);
  return keywordCache;
}

let domesticAdapter = null;
function domestic() {
  if (!domesticAdapter)
    domesticAdapter = createDomesticModerationAdapter({ url: MODERATION_API_URL, apiKey: MODERATION_API_KEY, timeoutMs: MODERATION_TIMEOUT_MS });
  return domesticAdapter;
}

/** Test hook: swap the domestic adapter / keyword list. */
export function setModerationDependenciesForTests({ adapter = null, keywordList = null } = {}) {
  domesticAdapter = adapter;
  keywordCache = keywordList;
}

/**
 * @param {Record<string, string>} fields
 * @param {{ provider?: string, scene?: string }} [options]
 */
export async function moderateFields(fields, { provider = MODERATION_PROVIDER, scene = 'ugc' } = {}) {
  if (provider === 'none') return { decision: 'pass', provider, hits: [], labels: [] };
  const prefilter = keywordPrefilter(fields, { keywords: keywords() });
  if (provider !== 'domestic') return { decision: prefilter.decision, provider: 'keyword', hits: prefilter.hits, labels: [] };
  const text = Object.values(fields)
    .filter((value) => String(value ?? '').trim())
    .join('\n');
  const remote = text ? await domestic().check(text, scene) : { decision: 'pass', labels: [] };
  return { decision: strictestDecision(prefilter.decision, remote.decision), provider: 'domestic', hits: prefilter.hits, labels: remote.labels };
}

const state = { byEntity: new Map(), loadedAt: 0, loading: null };
onJsonlAppend(MODERATION_QUEUE_LOG_PATH, () => {
  state.loadedAt = 0;
});

function entityKey(entityType, entityId) {
  return `${entityType}:${entityId}`;
}

function replay(rowsOldestFirst) {
  const byEntity = new Map();
  for (const row of rowsOldestFirst) {
    if (!MODERATION_ENTITY_TYPES.includes(row?.entityType) || !row?.entityId) continue;
    const key = entityKey(row.entityType, row.entityId);
    const previous = byEntity.get(key);
    if (row.type === 'moderation-item') byEntity.set(key, { ...row, history: [...(previous?.history ?? []), row] });
    else if (row.type === 'moderation-decision' && previous) {
      byEntity.set(key, {
        ...previous,
        status: row.action === 'approve' ? 'approved' : 'rejected',
        decidedAt: row.createdAt,
        history: [...previous.history, row]
      });
    }
  }
  return byEntity;
}

export async function refreshModerationState({ force = false } = {}) {
  if (!force && state.loadedAt && Date.now() - state.loadedAt < STATE_TTL_MS) return state;
  if (state.loading) return state.loading;
  state.loading = (async () => {
    state.byEntity = replay((await readJsonLines(MODERATION_QUEUE_LOG_PATH, Number.POSITIVE_INFINITY)).reverse());
    state.loadedAt = Date.now();
    return state;
  })();
  try {
    return await state.loading;
  } finally {
    state.loading = null;
  }
}

/** Sync check against the last refreshed state (refreshed per API request and on append). */
export function isModerationWithheld(entityType, entityId) {
  const entry = state.byEntity.get(entityKey(entityType, String(entityId ?? '')));
  return Boolean(entry && WITHHELD_STATUSES.has(entry.status));
}

/**
 * Runs moderation for new public content and queues it when flagged.
 * Returns { decision, status } where status is null when nothing was queued.
 */
export async function moderateAndQueue({ entityType, entityId, profileId = '', fields, scene }) {
  const result = await moderateFields(fields, { scene });
  const previous = (await refreshModerationState()).byEntity.get(entityKey(entityType, entityId));
  // Clean content is not queued, except to clear an earlier hold on the same entity
  // (e.g. a routebook re-published after editing).
  if (result.decision === 'pass' && !(previous && WITHHELD_STATUSES.has(previous.status))) return { ...result, status: null };
  const status = result.decision === 'block' ? 'blocked' : result.decision === 'review' ? 'pending' : 'passed';
  await appendJsonLine(MODERATION_QUEUE_LOG_PATH, {
    id: cryptoRandomId(),
    type: 'moderation-item',
    entityType,
    entityId,
    profileId,
    status,
    provider: result.provider,
    hits: result.hits.slice(0, 20),
    labels: result.labels,
    excerpt: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, truncateString(value, 300)])),
    createdAt: new Date().toISOString()
  });
  await refreshModerationState({ force: true });
  return { ...result, status };
}

// Ops views identify content, not people.
function withoutProfileIds(entry) {
  const { profileId: _profileId, history = [], ...rest } = entry;
  return { ...rest, history: history.map(({ profileId: _ignored, ...row }) => row) };
}

export async function listModerationQueue({ status = 'open', limit = 100 } = {}) {
  const current = await refreshModerationState({ force: true });
  const rows = [...current.byEntity.values()]
    .filter((entry) => (status === 'open' ? ['pending', 'blocked'].includes(entry.status) : status === 'all' || entry.status === status))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, Math.max(1, Math.min(500, Number(limit) || 100)));
  return {
    items: rows.map(withoutProfileIds),
    provider: MODERATION_PROVIDER,
    domesticConfigured: MODERATION_PROVIDER === 'domestic' && domestic().configured
  };
}

export async function decideModeration(req, entityType, entityId, input) {
  const reason = validateOpsAuditInput(input);
  const action = String(input?.action ?? '');
  if (!['approve', 'reject'].includes(action)) throw createHttpError('审核动作只能是 approve / reject', 400, 'MODERATION_ACTION_INVALID');
  if (!MODERATION_ENTITY_TYPES.includes(entityType)) throw createHttpError('审核对象类型不合法', 400, 'MODERATION_ENTITY_INVALID');
  const id = sanitizePublicId(entityId);
  return withStorageEntityLock('moderation', entityKey(entityType, id), async () => {
    const current = (await refreshModerationState({ force: true })).byEntity.get(entityKey(entityType, id));
    if (!current) throw createHttpError('审核记录不存在', 404, 'MODERATION_NOT_FOUND');
    const row = {
      id: cryptoRandomId(),
      type: 'moderation-decision',
      entityType,
      entityId: id,
      // Copied so profile deletion removes decisions together with the item.
      profileId: current.profileId ?? '',
      action,
      reason,
      actor: opsActorForRequest(req),
      createdAt: new Date().toISOString()
    };
    await appendJsonLine(MODERATION_QUEUE_LOG_PATH, row);
    const next = (await refreshModerationState({ force: true })).byEntity.get(entityKey(entityType, id));
    return { item: withoutProfileIds(next) };
  });
}

// Ops review queue for duplicate POIs. Candidates are computed on demand from the catalog;
// only a human decision (merge / reject / unmerge) with a reason is stored, append-only, in
// the poi-merges stream, which doubles as the audit trail. Merges are reversible.
import { POI_MERGE_LOG_PATH } from '../config/index.mjs';
import { appendJsonLine, readJsonLines } from '../storage/jsonl.mjs';
import { withStorageEntityLock } from '../storage/runtime.mjs';
import { createHttpError, sanitizePublicId, truncateString } from '../lib/util.mjs';
import { cryptoRandomId } from '../auth/tokens.mjs';
import { opsActorForRequest, validateOpsAuditInput } from '../ops/audit.mjs';
import { listMergedPois, refreshPoiCatalog } from './catalog.mjs';
import { POI_MERGE_DECISIONS, findPoiDuplicateCandidates, poiPairKey, replayPoiMergeDecisions } from './mergeRules.mjs';

async function readMergeState() {
  return replayPoiMergeDecisions((await readJsonLines(POI_MERGE_LOG_PATH, Number.POSITIVE_INFINITY)).reverse());
}

function mergeView(state) {
  return [...state.redirects.entries()]
    .map(([duplicatePoiId, canonicalPoiId]) => {
      const row = state.pairs.get(poiPairKey(duplicatePoiId, canonicalPoiId));
      return { canonicalPoiId, duplicatePoiId, reason: row?.reason ?? '', actor: row?.actor ?? '', createdAt: row?.createdAt ?? '' };
    })
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export async function listPoiDuplicateQueue({ city = '', limit = 100 } = {}) {
  const [pois, state] = await Promise.all([listMergedPois(), readMergeState()]);
  return {
    candidates: findPoiDuplicateCandidates(pois, { pairs: state.pairs, redirects: state.redirects, city: truncateString(city, 40), limit }),
    merges: mergeView(state),
    conflicts: state.conflicts.length
  };
}

export async function listPoiMergeDecisions(limit = 200) {
  return (await readJsonLines(POI_MERGE_LOG_PATH, Number.POSITIVE_INFINITY)).slice(0, Math.max(1, Math.min(1000, Number(limit) || 200)));
}

/** Records one human decision after validating it against the current catalog and merges. */
export async function recordPoiMergeDecision(req, input) {
  const reason = validateOpsAuditInput(input);
  const decision = String(input?.decision ?? '');
  if (!POI_MERGE_DECISIONS.includes(decision)) throw createHttpError('合并决定只能是 merge / reject / unmerge', 400, 'POI_MERGE_DECISION_INVALID');
  const canonicalPoiId = sanitizePublicId(input?.canonicalPoiId);
  const duplicatePoiId = sanitizePublicId(input?.duplicatePoiId);
  if (!canonicalPoiId || !duplicatePoiId || canonicalPoiId === duplicatePoiId) {
    throw createHttpError('需要两个不同的 POI', 400, 'POI_MERGE_PAIR_INVALID');
  }
  // One global lock: a merge decision depends on every other active merge (chains/cycles).
  return withStorageEntityLock('poi-merge', 'catalog', async () => {
    const [pois, state] = await Promise.all([listMergedPois(), readMergeState()]);
    const byId = new Map(pois.map((poi) => [poi.poiId, poi]));
    const canonical = byId.get(canonicalPoiId);
    const duplicate = byId.get(duplicatePoiId);
    if (!canonical || !duplicate) throw createHttpError('POI 不存在', 404, 'POI_MERGE_POI_NOT_FOUND');
    if (canonical.city !== duplicate.city) throw createHttpError('只能合并同城 POI', 409, 'POI_MERGE_CITY_MISMATCH');
    const key = poiPairKey(canonicalPoiId, duplicatePoiId);
    const activeForPair = state.redirects.get(duplicatePoiId) === canonicalPoiId;
    const activeReverse = state.redirects.get(canonicalPoiId) === duplicatePoiId;
    if (decision === 'merge') {
      if (canonical.sourceKind !== 'seed' && canonical.reviewStatus !== 'approved') {
        throw createHttpError('保留的规范 POI 必须是已审核或种子 POI', 409, 'POI_MERGE_CANONICAL_NOT_APPROVED');
      }
      if (state.redirects.has(duplicatePoiId)) throw createHttpError('该 POI 已合并到其他 POI，请先撤销', 409, 'POI_MERGE_ALREADY_MERGED');
      if (state.redirects.has(canonicalPoiId)) throw createHttpError('规范 POI 本身已被合并，请选择其最终规范 POI', 409, 'POI_MERGE_CHAIN');
      if ([...state.redirects.values()].includes(duplicatePoiId)) {
        throw createHttpError('该 POI 是其他 POI 的规范目标，请先撤销那些合并', 409, 'POI_MERGE_CHAIN');
      }
    } else if (decision === 'unmerge') {
      if (!activeForPair) throw createHttpError('这两个 POI 当前没有合并关系', 409, 'POI_MERGE_NOT_ACTIVE');
    } else if (activeForPair || activeReverse) {
      throw createHttpError('这两个 POI 已合并，请先撤销合并', 409, 'POI_MERGE_ACTIVE');
    }
    const row = {
      id: cryptoRandomId(),
      type: 'poi-merge-decision',
      decision,
      pairKey: key,
      canonicalPoiId,
      duplicatePoiId,
      city: canonical.city,
      // Names at decision time, so the audit trail stays readable if POIs are renamed later.
      canonicalName: truncateString(canonical.name, 80),
      duplicateName: truncateString(duplicate.name, 80),
      reason,
      actor: opsActorForRequest(req),
      createdAt: new Date().toISOString()
    };
    await appendJsonLine(POI_MERGE_LOG_PATH, row);
    await refreshPoiCatalog({ force: true });
    return { decision: row, merges: mergeView(await readMergeState()) };
  });
}

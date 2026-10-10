// Routebook version chains, optimistic concurrency and audits.
import { positiveInteger, sanitizePublicId, normalizeCityName, truncateString, normalizeRoutebookActorType, createHttpError } from '../lib/util.mjs';
import { ROUTEBOOK_LOG_PATH, ROUTEBOOK_STATUSES, ROUTEBOOK_AUDIT_LOG_PATH } from '../config/index.mjs';
import { onJsonlAppend, readRecentJsonlRows, jsonlFileFingerprint, appendJsonLine, readJsonLines } from '../storage/jsonl.mjs';
import { ROUTEBOOK_HISTORY_PROJECTION } from '../storage/projections.mjs';
import { cryptoRandomId } from '../auth/tokens.mjs';
import { assertRoutebookNotDeleted, isDeletedRoutebook } from './tombstones.mjs';

// rank23③：路书 id -> 当前最大版本号 的惰性内存 Map。首次访问全量扫描一次，
// 之后 appendJsonLine 落 routebooks.jsonl 时增量更新，替代每次保存的全窗口扫描。
// 指纹不匹配（外部进程直写 JSONL）时重建，保持与 listRoutebookVersionRows 同口径。
const routebookVersionCache = { byId: null, fingerprint: '' };

function applyRoutebookVersionRow(byId, row) {
  const id = sanitizePublicId(row?.id || row?.publicId);
  if (!id) return;
  const currentVersion = byId.get(id) ?? 0;
  const explicitVersion = positiveInteger(row?.version);
  byId.set(id, Math.max(currentVersion, explicitVersion ?? currentVersion + 1));
}

async function noteRoutebookVersionAppend(payload) {
  if (!routebookVersionCache.byId) return;
  applyRoutebookVersionRow(routebookVersionCache.byId, payload);
  // 不回写指纹：并发/外部写入落盘后再 stat 会拿到「新于 byId 已消化行」的
  // 指纹，把别人的行标记成已合并。置空强制下次 currentRoutebookVersion 校验重建。
  routebookVersionCache.fingerprint = '';
}

onJsonlAppend(ROUTEBOOK_LOG_PATH, noteRoutebookVersionAppend);

export async function listRoutebookVersionRows(publicId) {
  const id = sanitizePublicId(publicId);
  if (!id) return [];
  const rows = (await readRecentJsonlRows(ROUTEBOOK_LOG_PATH, 50000, ROUTEBOOK_HISTORY_PROJECTION))
    .slice(0, 50000)
    .filter((row) => sanitizePublicId(row?.id || row?.publicId) === id)
    .reverse();
  let currentVersion = 0;
  const versions = [];
  rows.forEach((row, index) => {
    const explicitVersion = positiveInteger(row?.version);
    const version = explicitVersion ?? currentVersion + 1;
    currentVersion = Math.max(currentVersion, version);
    const parentVersion = positiveInteger(row?.parentVersion) ?? (version > 1 ? version - 1 : null);
    const normalized = {
      schemaVersion: positiveInteger(row?.schemaVersion, explicitVersion ? 2 : 1),
      version,
      parentVersion: parentVersion != null && parentVersion < version ? parentVersion : null,
      derived: explicitVersion == null,
      snapshotOrdinal: index + 1,
      routebookId: id,
      title: truncateString(row?.title, 80),
      city: row?.city ? normalizeCityName(row.city) : '',
      publishStatus: ROUTEBOOK_STATUSES.has(row?.publishStatus) ? row.publishStatus : 'draft',
      changeReason: truncateString(row?.changeReason || row?.editReason, 160) || (explicitVersion ? '路书快照' : '历史快照'),
      actorType: normalizeRoutebookActorType(row?.actorType || (row?.profileId ? 'user' : 'migration')),
      createdAt: truncateString(row?.createdAt, 60) || truncateString(row?.updatedAt, 60),
      updatedAt: truncateString(row?.updatedAt, 60),
      publishedAt: truncateString(row?.publishedAt, 60),
      archivedAt: truncateString(row?.archivedAt, 60)
    };
    const existingIndex = explicitVersion == null ? -1 : versions.findIndex((item) => item.version === version);
    if (existingIndex >= 0) versions[existingIndex] = normalized;
    else versions.push(normalized);
  });
  return versions.sort((left, right) => left.version - right.version || left.snapshotOrdinal - right.snapshotOrdinal);
}

// rank23③：不再每次保存都扫全窗口重放版本链；用惰性构建的 id -> maxVersion
// 内存 Map 查询，推导规则与 listRoutebookVersionRows 一致（显式 version 优先，
// 缺失时按快照顺序递增）。
export async function currentRoutebookVersion(publicId) {
  const id = sanitizePublicId(publicId);
  if (!id) return 0;
  const fingerprint = await jsonlFileFingerprint(ROUTEBOOK_LOG_PATH);
  if (!routebookVersionCache.byId || routebookVersionCache.fingerprint !== fingerprint) {
    const byId = new Map();
    // 全量重建不设行数上限：与 getSavedRoutebook 的全文件口径一致，否则超限后
    // 旧路书能查到快照却拿到 version 0，触发误判的版本冲突/覆盖。
    const chronologicalRows = (await readRecentJsonlRows(ROUTEBOOK_LOG_PATH, Number.POSITIVE_INFINITY, ROUTEBOOK_HISTORY_PROJECTION)).slice().reverse();
    for (const row of chronologicalRows) applyRoutebookVersionRow(byId, row);
    routebookVersionCache.byId = byId;
    routebookVersionCache.fingerprint = fingerprint;
  }
  return routebookVersionCache.byId.get(id) ?? 0;
}

function expectedVersionWasProvided(input) {
  return input != null && Object.prototype.hasOwnProperty.call(input, 'expectedVersion') && input.expectedVersion !== '' && input.expectedVersion != null;
}

export function assertExpectedRoutebookVersion(input, currentVersion, { required = false } = {}) {
  if (!expectedVersionWasProvided(input)) {
    if (required) {
      const error = createHttpError('更新已有路书必须携带 expectedVersion', 409, 'EXPECTED_VERSION_REQUIRED');
      error.currentVersion = currentVersion;
      throw error;
    }
    return;
  }
  const expectedVersion = Number(input.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    throw createHttpError('expectedVersion 必须是非负整数', 400, 'EXPECTED_VERSION_INVALID');
  }
  if (expectedVersion !== currentVersion) {
    const error = createHttpError(`路书版本冲突，当前版本为 ${currentVersion}`, 409, 'VERSION_CONFLICT');
    error.currentVersion = currentVersion;
    throw error;
  }
}

export async function routebookMutationMetadata(existingRoutebook, input, { changeReason, actorType }) {
  const id = sanitizePublicId(existingRoutebook?.publicId || existingRoutebook?.id);
  const currentVersion = id ? await currentRoutebookVersion(id) : 0;
  assertExpectedRoutebookVersion(input, currentVersion, { required: true });
  const now = new Date().toISOString();
  return {
    schemaVersion: 2,
    version: currentVersion + 1,
    parentVersion: currentVersion || null,
    createdAt: truncateString(existingRoutebook?.createdAt, 60) || truncateString(existingRoutebook?.updatedAt, 60) || now,
    publishedAt: truncateString(existingRoutebook?.publishedAt, 60),
    archivedAt: truncateString(existingRoutebook?.archivedAt, 60),
    changeReason: truncateString(input?.changeReason || changeReason, 160),
    actorType: normalizeRoutebookActorType(input?.actorType || actorType)
  };
}

function buildRoutebookAudit(routebook, event, details = {}) {
  const routebookId = sanitizePublicId(routebook?.publicId || routebook?.id);
  if (!routebookId) return null;
  return {
    id: cryptoRandomId(),
    routebookId,
    event: truncateString(event, 40),
    version: positiveInteger(routebook?.version, 1),
    parentVersion: positiveInteger(routebook?.parentVersion),
    publishStatus: ROUTEBOOK_STATUSES.has(routebook?.publishStatus) ? routebook.publishStatus : 'draft',
    changeReason: truncateString(routebook?.changeReason, 160),
    actorType: normalizeRoutebookActorType(routebook?.actorType),
    createdAt: new Date().toISOString(),
    ...details
  };
}

export async function appendVersionedRoutebook(routebook, event, details = {}) {
  // Never resurrect a deleted routebook, whatever the write path.
  if (!isDeletedRoutebook(routebook)) await assertRoutebookNotDeleted(routebook?.publicId || routebook?.id);
  const versionAudit = buildRoutebookAudit(routebook, event, details);
  await appendJsonLine(ROUTEBOOK_LOG_PATH, versionAudit ? { ...routebook, versionAudit } : routebook, { expectedVersion: routebook.parentVersion ?? 0 });
}

export async function listRoutebookAudits(publicId) {
  const routebookId = sanitizePublicId(publicId);
  if (!routebookId) return [];
  const snapshots = (await readRecentJsonlRows(ROUTEBOOK_LOG_PATH, 50000, ROUTEBOOK_HISTORY_PROJECTION)).slice(0, 50000);
  let legacyAudits = [];
  try {
    legacyAudits = await readJsonLines(ROUTEBOOK_AUDIT_LOG_PATH, 50000);
  } catch (error) {
    if (!['ENOENT', 'EISDIR', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error?.code)) throw error;
  }
  const auditsByVersionAndEvent = new Map();
  legacyAudits
    .filter((audit) => sanitizePublicId(audit?.routebookId) === routebookId)
    .forEach((audit) => {
      auditsByVersionAndEvent.set(`${positiveInteger(audit?.version, 1)}:${truncateString(audit?.event, 40)}`, audit);
    });
  snapshots
    .filter((snapshot) => sanitizePublicId(snapshot?.id || snapshot?.publicId) === routebookId && snapshot?.versionAudit)
    .forEach((snapshot) => {
      const audit = snapshot.versionAudit;
      if (sanitizePublicId(audit?.routebookId) !== routebookId) return;
      auditsByVersionAndEvent.set(`${positiveInteger(audit?.version, 1)}:${truncateString(audit?.event, 40)}`, audit);
    });
  return [...auditsByVersionAndEvent.values()].sort(
    (left, right) =>
      positiveInteger(left?.version, 1) - positiveInteger(right?.version, 1) || String(left?.createdAt ?? '').localeCompare(String(right?.createdAt ?? ''))
  );
}

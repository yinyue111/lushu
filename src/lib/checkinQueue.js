import * as api from './api.js';
import { getProfile } from './profile.js';
import { adoptServerProfile } from './profileSync.js';

const INTERRUPTED_SYNC_STATUSES = new Set(['pending', 'syncing']);
// profileId 在本地字段清单里：服务端把未注册身份降级为 anonymous 时，
// 不能让返回行覆盖本地归属，否则打卡会静默失去主人。
const LOCAL_FIELDS = ['clientLocalId', 'clientAction', 'localStopKey', 'stopId', 'stopName', 'profileId'];
const DEFAULT_RETRY_DELAY_MS = 15_000;
const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429]);
// 与 src/lib/storage.js 的 CHECKIN_PREFIX 保持一致（跨路书扫描本地打卡队列用）。
const CHECKIN_STORAGE_PREFIX = 'trusted-routebook:checkins:';
// 身份类同步错误：可通过注册/同步身份修复，保持可重试而不是死路。
const PROFILE_SYNC_ERROR_CODES = new Set(['PROFILE_NOT_REGISTERED', 'PROFILE_TOKEN_REQUIRED']);
const PROFILE_SYNC_GUIDANCE = '身份未同步，请到『我的页』同步身份或输入恢复码后重试';
// 照片被服务端明确拒绝时放弃照片、继续上传打卡行本身。
const PHOTO_TERMINAL_ERROR_CODES = new Set(['PHOTO_INVALID', 'PHOTO_TOO_LARGE']);
// 本地打卡队列截断上限：与迁移侧 storage.js 的 MAX_SCOPED_LIST_ROWS 保持一致。
const MAX_QUEUE_ROWS = 120;
// 旧身份行连续跳过上限：达到后停止自动重试，避免每 15 秒空转刷错误。
const FOREIGN_PROFILE_MAX_AUTO_RETRIES = 8;
const FOREIGN_PROFILE_GUIDANCE = '该记录属于其他本地身份，请在该身份下打开或手动处理';

export function queueCheckin(rows, row) {
  const clientLocalId = requireClientLocalId(row);
  const existing = safeRows(rows).find((item) => clientIdOf(item) === clientLocalId);
  if (isServerSyncedCheckin(existing)) return safeRows(rows);
  return upsertCheckin(rows, {
    ...row,
    clientSyncStatus: 'queued',
    clientSyncError: '',
    clientSyncRetryable: true,
    clientSyncRetryAt: '',
    clientSyncHttpStatus: ''
  });
}

export function markCheckinSyncing(rows, clientLocalId) {
  return updateCheckin(rows, clientLocalId, (row) => ({
    ...row,
    clientSyncStatus: 'syncing',
    clientSyncError: '',
    clientSyncRetryable: true,
    clientSyncRetryAt: '',
    clientSyncHttpStatus: ''
  }));
}

export function markCheckinFailed(rows, clientLocalId, error, options = {}) {
  return updateCheckin(rows, clientLocalId, (row) => {
    const failure = classifyCheckinSyncError(error, {
      ...options,
      clientLocalId: row.clientLocalId
    });
    return {
      ...row,
      clientSyncStatus: 'failed',
      clientSyncError: failure.guidance || errorMessage(error),
      clientSyncRetryable: failure.retryable,
      clientSyncRetryAt: failure.retryAt,
      clientSyncHttpStatus: failure.status ?? '',
      clientSyncAttempts: Math.max(0, Number(row.clientSyncAttempts) || 0) + 1
    };
  });
}

export function requeueCheckin(rows, clientLocalId) {
  return updateCheckin(rows, clientLocalId, (row) => {
    if (isServerSyncedCheckin(row)) return row;
    return {
      ...row,
      clientSyncStatus: 'queued',
      clientSyncError: '',
      clientSyncRetryable: true,
      clientSyncRetryAt: '',
      clientSyncHttpStatus: ''
    };
  });
}

export function markCheckinSynced(rows, clientLocalId, serverRow = {}) {
  return updateCheckin(rows, clientLocalId, (localRow) => {
    const synced = {
      ...localRow,
      ...(serverRow && typeof serverRow === 'object' ? serverRow : {}),
      clientSyncStatus: 'synced',
      clientSyncError: '',
      clientSyncRetryable: false,
      clientSyncRetryAt: '',
      clientSyncHttpStatus: ''
    };

    for (const field of LOCAL_FIELDS) {
      if (Object.hasOwn(localRow, field)) synced[field] = localRow[field];
    }
    // 已同步行的照片要么已上传（photoId 随服务端行回填），要么无法再补挂：
    // 剥离本地暂存的 dataURL，防最大 400KB 的照片永久滞留 localStorage。
    return stripSyncedPhotoData(synced);
  });
}

export function recoverInterruptedCheckins(rows) {
  return safeRows(rows).map((row) => {
    if (!INTERRUPTED_SYNC_STATUSES.has(row?.clientSyncStatus)) return row;
    return {
      ...row,
      clientSyncStatus: 'queued',
      clientSyncError: row.clientSyncError || '上次同步被页面刷新或关闭中断，已加入待同步队列',
      clientSyncRetryable: true,
      clientSyncRetryAt: '',
      clientSyncHttpStatus: ''
    };
  });
}

export function upsertCheckin(rows, row) {
  const clientLocalId = requireClientLocalId(row);
  const source = safeRows(rows);
  const index = source.findIndex((item) => clientIdOf(item) === clientLocalId);
  if (index < 0) return [...source, { ...row, clientLocalId }];

  const next = [...source];
  next[index] = { ...source[index], ...row, clientLocalId };
  return next;
}

export function listQueuedCheckins(rows, now = Date.now()) {
  const nowMs = timestampOf(now, Date.now());
  return safeRows(rows).filter((row) => {
    const status = row?.clientSyncStatus;
    if (status === 'queued' || status === 'pending') return true;
    if (status !== 'failed' || row.clientSyncRetryable === false) return false;
    const retryAtMs = timestampOf(row.clientSyncRetryAt, 0);
    return retryAtMs <= nowMs;
  });
}

export function classifyCheckinSyncError(error, options = {}) {
  const status = httpStatusOf(error);
  const code = String(error?.code ?? '').trim();
  const nowMs = timestampOf(options.now, Date.now());
  const retryDelayMs = Math.max(1_000, Number(options.retryDelayMs) || DEFAULT_RETRY_DELAY_MS);
  if (PROFILE_SYNC_ERROR_CODES.has(code)) {
    // 身份未注册/缺 token 属于可修复类错误：给出引导文案并保持自动重试。
    return {
      status,
      code,
      retryable: true,
      retryAt: new Date(nowMs + retryDelayMs).toISOString(),
      guidance: PROFILE_SYNC_GUIDANCE
    };
  }
  const retryable = status == null
    || RETRYABLE_HTTP_STATUSES.has(status)
    || status >= 500
    || (status === 409 && Boolean(options.clientLocalId));
  return {
    status,
    retryable,
    retryAt: retryable ? new Date(nowMs + retryDelayMs).toISOString() : ''
  };
}

// 模块级防并发重入：TripView / ReviewPage / App 全局补传共用同一个标记，
// 任一处 flush 进行中时其余调用直接空转返回。
let flushAllInFlight = false;

// 供调用方（如 TripView）判断全局补传是否进行中：flush 直接写 localStorage，
// 进行中时内存快照可能滞后，调用方应改以本地存储为准，避免覆盖回滚同步结果。
export function isCheckinFlushInFlight() {
  return flushAllInFlight;
}

// 扫描 localStorage 里所有打卡队列 key，对 queued/到期 failed 行执行上传。
// 含身份注册前置（未注册 profile 先注册再上传，避免服务端落 anonymous 行）
// 与照片补传（先传照片拿 photoId，再传打卡行）。离线时直接返回。
/** @param {{ profile?: any, signal?: AbortSignal }} [options] */
export async function flushAllCheckinQueues({ profile, signal } = {}) {
  const result = { attempted: 0, synced: 0, failed: 0 };
  if (flushAllInFlight) return result;
  if (typeof localStorage === 'undefined') return result;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return result;
  flushAllInFlight = true;
  try {
    // 任一 flush 入口（App 挂载/online/行中/回顾页/我的页）先救回上次刷新或关闭时
    // 卡在 pending/syncing 的行，再取队列；服务端按 clientLocalId 幂等，重复上传安全。
    recoverInterruptedQueueRows();
    if (!checkinQueueStorageKeys().some((key) => listQueuedCheckins(readQueueRows(key)).length > 0)) return result;
    let activeProfile = profile && typeof profile === 'object' && profile.id ? profile : null;
    try {
      const stored = getProfile();
      // 优先信任本地存储里的最新身份：调用方传入的 profile 可能是注册前的旧快照。
      if (!activeProfile || !activeProfile.profileAccessToken) activeProfile = stored;
    } catch {
      // profile 存储不可用时沿用调用方传入的 profile。
    }
    if (activeProfile?.id && activeProfile.id !== 'anonymous' && !activeProfile.profileAccessToken) {
      try {
        const data = await api.saveProfile(activeProfile, signal);
        const adopted = adoptServerProfile(data?.profile, activeProfile);
        // 注册后以服务端确认的身份为准，供下方旧身份行判定使用。
        if (adopted?.profile?.id) activeProfile = adopted.profile;
      } catch (error) {
        // 注册失败：保持 queued 可重试，不上传，避免服务端落 anonymous 行。
        result.registrationError = errorMessage(error);
        result.guidance = PROFILE_SYNC_GUIDANCE;
        return result;
      }
    }
    // 注册可能触发本地数据迁移（打卡队列 key 换 profileId），迁移后再扫描。
    for (const key of checkinQueueStorageKeys()) {
      if (signal?.aborted) return result;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return result;
      const queuedIds = sortCheckinsByTime(listQueuedCheckins(readQueueRows(key)))
        .map((row) => clientIdOf(row))
        .filter(Boolean);
      for (const clientLocalId of queuedIds) {
        if (signal?.aborted) return result;
        result.attempted += 1;
        const scanned = readQueueRows(key).find((item) => clientIdOf(item) === clientLocalId);
        if (!scanned) continue;
        const rowOwner = String(scanned.profileId ?? '').trim();
        const activeOwner = String(activeProfile?.id ?? '').trim();
        if (rowOwner && activeOwner && rowOwner !== activeOwner) {
          // 旧身份行止损：用当前身份上传会被服务端拒绝或错误归属，跳过并计数，
          // 连续多次后停止自动重试，等用户在原身份下打开或手动处理。
          writeQueueRows(key, markCheckinForeignProfile(readQueueRows(key), clientLocalId));
          result.failed += 1;
          continue;
        }
        writeQueueRows(key, markCheckinSyncing(readQueueRows(key), clientLocalId));
        let row = readQueueRows(key).find((item) => clientIdOf(item) === clientLocalId);
        if (!row) continue;
        if (row.clientPhotoData && !row.photoId) {
          try {
            const uploaded = await api.uploadCheckinPhoto({
              profileId: row.profileId,
              routeId: row.routeId,
              stopId: row.stopId,
              clientLocalId: row.clientLocalId,
              imageBase64: row.clientPhotoData,
              mimeType: row.clientPhotoMimeType || 'image/jpeg'
            }, signal);
            const photoId = String(uploaded?.photo?.id ?? '').trim();
            writeQueueRows(key, clearQueuedPhotoData(readQueueRows(key), clientLocalId, photoId));
          } catch (error) {
            if (error?.name === 'AbortError') {
              writeQueueRows(key, requeueCheckin(readQueueRows(key), clientLocalId));
              return result;
            }
            if (PHOTO_TERMINAL_ERROR_CODES.has(String(error?.code ?? '')) || error?.status === 413) {
              // 照片被服务端明确拒绝：放弃照片，打卡行继续上传。
              writeQueueRows(key, clearQueuedPhotoData(readQueueRows(key), clientLocalId, ''));
            } else {
              writeQueueRows(key, markCheckinFailed(readQueueRows(key), clientLocalId, error));
              result.failed += 1;
              continue;
            }
          }
          row = readQueueRows(key).find((item) => clientIdOf(item) === clientLocalId) ?? row;
        }
        try {
          const uploaded = await api.createCheckin(checkinForApi(row), signal);
          writeQueueRows(key, markCheckinSynced(readQueueRows(key), clientLocalId, uploaded?.checkin));
          result.synced += 1;
        } catch (error) {
          if (error?.name === 'AbortError') {
            writeQueueRows(key, requeueCheckin(readQueueRows(key), clientLocalId));
            return result;
          }
          writeQueueRows(key, markCheckinFailed(readQueueRows(key), clientLocalId, error));
          result.failed += 1;
        }
      }
    }
    return result;
  } finally {
    flushAllInFlight = false;
  }
}

export function isLocallyProcessedCheckin(row) {
  if (!row || typeof row !== 'object') return false;
  return Boolean(
    row.status === 'skipped' ||
    row.status === 'replaced' ||
    row.status === 'visited' ||
    row.worth ||
    row.arrival?.valid === true ||
    row.arrivalConfidence === 'valid' ||
    ['visit', 'skip', 'replace'].includes(row.clientAction?.type)
  );
}

export function isServerSyncedCheckin(row) {
  return Boolean(row) && (!row.clientSyncStatus || row.clientSyncStatus === 'synced');
}

export function checkinEvidenceState(row) {
  const syncStatus = normalizeSyncStatus(row);
  const arrivalConfidence = String(row?.arrivalConfidence || row?.arrival?.confidence || '').trim();
  const hasArrivalVerdict = typeof row?.arrival?.valid === 'boolean';
  const validArrival = hasArrivalVerdict ? row.arrival.valid === true : arrivalConfidence === 'valid';
  const identityAttested = row?.trustState === 'profile-attested';
  // Mirrors the server's PUBLIC_TRUST_ELIGIBLE_STATES: a phone/WeChat binding upgrades a
  // sample but is not required for it to count, otherwise nothing ever gets verified.
  const identityDurable = identityAttested || row?.trustState === 'profile-owned';
  return {
    localCompleted: isLocallyProcessedCheckin(row),
    syncStatus,
    arrivalConfidence: arrivalConfidence || (syncStatus === 'synced' ? 'unverified' : 'pending'),
    validArrival,
    identityAttested,
    identityDurable,
    countsTowardPublicTrust: row?.status === 'visited' && syncStatus === 'synced' && identityDurable && validArrival
  };
}

// 写回前统一截断：超过上限时优先丢弃已同步行（服务端已有副本、越旧越先丢），
// 保住 queued/failed 等未同步行；全部未同步仍超限时保留最新的行。
export function capCheckinRows(rows, limit = MAX_QUEUE_ROWS) {
  const source = safeRows(rows).map(stripSyncedPhotoData);
  if (source.length <= limit) return source;
  let dropCount = source.length - limit;
  const kept = [];
  for (const row of source) {
    if (dropCount > 0 && isServerSyncedCheckin(row)) {
      dropCount -= 1;
      continue;
    }
    kept.push(row);
  }
  return kept.length > limit ? kept.slice(-limit) : kept;
}

function checkinQueueStorageKeys() {
  try {
    return Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
      .filter((key) => typeof key === 'string' && key.startsWith(CHECKIN_STORAGE_PREFIX));
  } catch {
    return [];
  }
}

function readQueueRows(key) {
  try {
    const rows = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function writeQueueRows(key, rows) {
  try {
    localStorage.setItem(key, JSON.stringify(capCheckinRows(rows)));
    return true;
  } catch {
    return false;
  }
}

// flush 入口的中断行自恢复：把上次卡在 pending/syncing 的行救回 queued，
// 覆盖 App 挂载/online/行中/回顾页/我的页等所有触发路径。
function recoverInterruptedQueueRows() {
  for (const key of checkinQueueStorageKeys()) {
    const rows = readQueueRows(key);
    const recovered = recoverInterruptedCheckins(rows);
    if (recovered.some((row, index) => row !== rows[index])) writeQueueRows(key, recovered);
  }
}

// 旧身份行：row.profileId 与当前身份不一致时不上传，仅累计尝试次数；
// 达到上限后转为不可自动重试，不影响正常行的重试语义。
function markCheckinForeignProfile(rows, clientLocalId, now = Date.now()) {
  return updateCheckin(rows, clientLocalId, (row) => {
    const attempts = Math.max(0, Number(row.clientSyncAttempts) || 0) + 1;
    const retryable = attempts < FOREIGN_PROFILE_MAX_AUTO_RETRIES;
    return {
      ...row,
      clientSyncStatus: 'failed',
      clientSyncError: FOREIGN_PROFILE_GUIDANCE,
      clientSyncRetryable: retryable,
      clientSyncRetryAt: retryable ? new Date(timestampOf(now, Date.now()) + DEFAULT_RETRY_DELAY_MS).toISOString() : '',
      clientSyncHttpStatus: '',
      clientSyncAttempts: attempts
    };
  });
}

// 已 synced 仍带本地照片 dataURL 的行在合并/写回时剥离，防照片永久滞留 localStorage。
function stripSyncedPhotoData(row) {
  if (!row || typeof row !== 'object' || !row.clientPhotoData) return row;
  if (!isServerSyncedCheckin(row)) return row;
  const { clientPhotoData: _clientPhotoData, ...rest } = row;
  return rest;
}

function sortCheckinsByTime(rows) {
  return [...safeRows(rows)].sort((left, right) => {
    const leftTime = String(left?.time ?? left?.createdAt ?? '');
    const rightTime = String(right?.time ?? right?.createdAt ?? '');
    return leftTime.localeCompare(rightTime) || clientIdOf(left).localeCompare(clientIdOf(right));
  });
}

// 照片上传成功（或被服务端终态拒绝）后清掉本地暂存的 dataURL，防 localStorage 膨胀。
function clearQueuedPhotoData(rows, clientLocalId, photoId) {
  return updateCheckin(rows, clientLocalId, (row) => {
    const { clientPhotoData: _clientPhotoData, ...rest } = row;
    return photoId ? { ...rest, photoId } : rest;
  });
}

// 上传给服务端时剥离客户端本地字段（同步状态机与照片暂存数据）。
function checkinForApi(row) {
  const {
    clientSyncStatus: _clientSyncStatus,
    clientSyncError: _clientSyncError,
    clientSyncRetryable: _clientSyncRetryable,
    clientSyncRetryAt: _clientSyncRetryAt,
    clientSyncHttpStatus: _clientSyncHttpStatus,
    clientSyncAttempts: _clientSyncAttempts,
    clientAction: _clientAction,
    clientPhotoData: _clientPhotoData,
    clientPhotoMimeType: _clientPhotoMimeType,
    storageKey: _storageKey,
    ...payload
  } = row;
  return payload;
}

function updateCheckin(rows, clientLocalId, updater) {
  const id = clientIdOf(clientLocalId);
  if (!id) return safeRows(rows);

  let found = false;
  const next = safeRows(rows).map((row) => {
    if (clientIdOf(row) !== id) return row;
    found = true;
    return updater(row);
  });
  return found ? next : safeRows(rows);
}

function requireClientLocalId(row) {
  const clientLocalId = clientIdOf(row);
  if (!clientLocalId) throw new TypeError('check-in row requires clientLocalId');
  return clientLocalId;
}

function clientIdOf(value) {
  const candidate = typeof value === 'string' ? value : value?.clientLocalId;
  return String(candidate ?? '').trim();
}

function errorMessage(error) {
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (error?.message) return String(error.message);
  return '网络或服务暂不可用，已保留在待同步队列';
}

function httpStatusOf(error) {
  const status = Number(error?.status);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

function timestampOf(value, fallback) {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? timestamp : fallback;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'string' && value.trim()) {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : fallback;
  }
  return fallback;
}

function normalizeSyncStatus(row) {
  if (!row || typeof row !== 'object') return 'queued';
  const status = String(row.clientSyncStatus ?? '').trim();
  if (['queued', 'pending', 'syncing', 'failed', 'synced'].includes(status)) {
    return status === 'pending' ? 'queued' : status;
  }
  return 'synced';
}

function safeRows(rows) {
  return Array.isArray(rows) ? rows : [];
}

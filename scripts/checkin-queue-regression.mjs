import assert from 'node:assert/strict';
import {
  checkinEvidenceState,
  classifyCheckinSyncError,
  flushAllCheckinQueues,
  isCheckinFlushInFlight,
  isLocallyProcessedCheckin,
  isServerSyncedCheckin,
  listQueuedCheckins,
  markCheckinFailed,
  markCheckinSynced,
  markCheckinSyncing,
  queueCheckin,
  requeueCheckin,
  recoverInterruptedCheckins,
  upsertCheckin
} from '../src/lib/checkinQueue.js';

const RETRY_STARTED_AT = Date.parse('2026-07-16T08:30:00.000Z');

const localAction = {
  type: 'replace',
  replacementStop: { id: 'west-lake-rain', name: '中国丝绸博物馆' },
  reason: '雨天替换'
};
const localRow = {
  clientLocalId: 'checkin-local-1',
  clientAction: localAction,
  routeId: 'hangzhou-weekend',
  stopId: 'west-lake',
  stopName: '西湖断桥',
  localStopKey: 'west-lake',
  status: 'replaced',
  worth: '替换',
  time: '2026-07-16T08:00:00.000Z'
};

const queued = queueCheckin([], localRow);
assert.equal(queued.length, 1);
assert.equal(queued[0].clientSyncStatus, 'queued');
assert.equal(isLocallyProcessedCheckin(queued[0]), true, 'queued actions must advance local trip progress');
assert.equal(isServerSyncedCheckin(queued[0]), false, 'queued actions must not count as server-synced');
assert.deepEqual(listQueuedCheckins(queued).map((row) => row.clientLocalId), ['checkin-local-1']);

const syncing = markCheckinSyncing(queued, 'checkin-local-1');
assert.equal(syncing[0].clientSyncStatus, 'syncing');
assert.equal(syncing[0].clientLocalId, localRow.clientLocalId);
assert.deepEqual(syncing[0].clientAction, localAction);

const failed = markCheckinFailed(syncing, 'checkin-local-1', new Error('offline'), { now: RETRY_STARTED_AT });
assert.equal(failed[0].clientSyncStatus, 'failed', 'failed sync must stay visible while remaining retryable');
assert.equal(failed[0].clientSyncError, 'offline');
assert.equal(failed[0].clientSyncRetryable, true);
assert.equal(failed[0].clientSyncRetryAt, '2026-07-16T08:30:15.000Z');
assert.equal(listQueuedCheckins(failed, RETRY_STARTED_AT).length, 0, 'a retryable failure must wait for its retry window');
assert.equal(listQueuedCheckins(failed, RETRY_STARTED_AT + 15_000).length, 1, 'a retryable failure becomes eligible after 15 seconds');
assert.deepEqual(checkinEvidenceState(failed[0]), {
  localCompleted: true,
  syncStatus: 'failed',
  arrivalConfidence: 'pending',
  validArrival: false,
  identityAttested: false,
  identityDurable: false,
  countsTowardPublicTrust: false
});

const retrying = markCheckinSyncing(failed, failed[0]);
const synced = markCheckinSynced(retrying, retrying[0], {
  id: 'server-checkin-9',
  clientLocalId: 'server-must-not-replace-local-id',
  clientAction: { type: 'visit' },
  stopId: 'server-stop-id',
  stopName: 'server stop name',
  localStopKey: 'server-stop-key',
  trustState: 'profile-attested',
  arrivalConfidence: 'valid',
  arrival: { valid: true, confidence: 'valid' }
});
assert.equal(synced.length, 1);
assert.equal(synced[0].id, 'server-checkin-9');
assert.equal(synced[0].clientLocalId, localRow.clientLocalId);
assert.deepEqual(synced[0].clientAction, localAction);
assert.equal(synced[0].stopId, localRow.stopId);
assert.equal(synced[0].stopName, localRow.stopName);
assert.equal(synced[0].localStopKey, localRow.localStopKey);
assert.equal(synced[0].clientSyncStatus, 'synced');
assert.equal(isServerSyncedCheckin(synced[0]), true);
assert.equal(listQueuedCheckins(synced).length, 0);
assert.equal(checkinEvidenceState(synced[0]).countsTowardPublicTrust, false, 'a replacement is never a public trust sample');

const trustedVisit = markCheckinSynced(queueCheckin([], {
  ...localRow,
  clientLocalId: 'trusted-visit',
  clientAction: { type: 'visit' },
  status: 'visited',
  worth: '值得'
}), 'trusted-visit', {
  status: 'visited',
  trustState: 'profile-attested',
  arrivalConfidence: 'valid',
  arrival: { valid: true, confidence: 'valid' }
});
assert.equal(checkinEvidenceState(trustedVisit[0]).countsTowardPublicTrust, true, 'only an attested synced visit with valid GPS counts');

const trustedSkip = markCheckinSynced(queueCheckin([], {
  ...localRow,
  clientLocalId: 'trusted-skip',
  clientAction: { type: 'skip' },
  status: 'skipped',
  worth: '跳过'
}), 'trusted-skip', {
  status: 'skipped',
  trustState: 'profile-attested',
  arrivalConfidence: 'valid',
  arrival: { valid: true, confidence: 'valid' }
});
assert.equal(checkinEvidenceState(trustedSkip[0]).countsTowardPublicTrust, false, 'a skipped row with GPS evidence is not a public trust sample');

const duplicateQueueAttempt = queueCheckin(synced, {
  ...localRow,
  comment: 'this must not requeue a server-synced action'
});
assert.equal(duplicateQueueAttempt.length, 1, 'same clientLocalId must remain one local record');
assert.equal(duplicateQueueAttempt[0].clientSyncStatus, 'synced', 'a synced clientLocalId must not upload again');
assert.notEqual(duplicateQueueAttempt[0].comment, 'this must not requeue a server-synced action');
assert.equal(listQueuedCheckins(duplicateQueueAttempt).length, 0, 'a duplicate submission must not return to the upload queue');

const updated = upsertCheckin(synced, {
  clientLocalId: localRow.clientLocalId,
  comment: 'retry result merged once'
});
assert.equal(updated.length, 1, 'retry upsert must not duplicate a local action');
assert.equal(updated[0].comment, 'retry result merged once');
assert.deepEqual(updated[0].clientAction, localAction);

const recovered = recoverInterruptedCheckins([
  { ...localRow, clientLocalId: 'legacy-pending', clientSyncStatus: 'pending' },
  { ...localRow, clientLocalId: 'interrupted-sync', clientSyncStatus: 'syncing' },
  { ...localRow, clientLocalId: 'legacy-failed', clientSyncStatus: 'failed', clientSyncError: 'timeout' },
  synced[0]
]);
assert.deepEqual(
  recovered.slice(0, 3).map((row) => row.clientSyncStatus),
  ['queued', 'queued', 'failed'],
  'refresh recovery must requeue interrupted uploads and preserve visible failures'
);
assert.equal(recovered[2].clientSyncError, 'timeout');
assert.deepEqual(
  listQueuedCheckins(recovered).map((row) => row.clientLocalId),
  ['legacy-pending', 'interrupted-sync', 'legacy-failed']
);
assert.equal(recovered.every((row) => row.clientLocalId), true);
assert.deepEqual(recovered[0].clientAction, localAction);

const feedbackOnly = markCheckinSynced(queueCheckin([], {
  ...localRow,
  clientLocalId: 'feedback-only',
  status: 'visited'
}), 'feedback-only', {
  status: 'visited',
  trustState: 'profile-attested',
  arrivalConfidence: 'unverified',
  arrival: { valid: false, confidence: 'unverified' }
});
assert.equal(checkinEvidenceState(feedbackOnly[0]).countsTowardPublicTrust, false, 'feedback without a valid GPS arrival is not a public trust sample');

const unboundValidArrival = markCheckinSynced(queueCheckin([], {
  ...localRow,
  clientLocalId: 'unbound-valid-arrival',
  status: 'visited'
}), 'unbound-valid-arrival', {
  status: 'visited',
  trustState: 'profile-owned',
  arrivalConfidence: 'valid',
  arrival: { valid: true, confidence: 'valid' }
});
assert.equal(checkinEvidenceState(unboundValidArrival[0]).identityAttested, false, 'profile-owned alone must not read as phone/WeChat attested');
assert.equal(checkinEvidenceState(unboundValidArrival[0]).countsTowardPublicTrust, true, 'profile-owned with valid GPS counts toward public trust, mirroring server PUBLIC_TRUST_ELIGIBLE_STATES');

const inconsistentArrival = markCheckinSynced(queueCheckin([], {
  ...localRow,
  clientLocalId: 'inconsistent-arrival',
  status: 'visited'
}), 'inconsistent-arrival', {
  status: 'visited',
  trustState: 'profile-attested',
  arrivalConfidence: 'valid',
  arrival: { valid: false, confidence: 'valid' }
});
assert.equal(checkinEvidenceState(inconsistentArrival[0]).countsTowardPublicTrust, false, 'explicit server arrival.valid=false must override a conflicting confidence label');

const permanentError = Object.assign(new Error('invalid check-in payload'), { status: 400 });
let isolatedQueue = queueCheckin([], {
  ...localRow,
  clientLocalId: 'permanent-first',
  status: 'visited',
  time: '2026-07-16T09:00:00.000Z'
});
isolatedQueue = queueCheckin(isolatedQueue, {
  ...localRow,
  clientLocalId: 'valid-second',
  status: 'visited',
  time: '2026-07-16T09:01:00.000Z'
});
isolatedQueue = markCheckinSyncing(isolatedQueue, 'permanent-first');
isolatedQueue = markCheckinFailed(isolatedQueue, 'permanent-first', permanentError, { now: RETRY_STARTED_AT });
assert.equal(isolatedQueue[0].clientSyncRetryable, false, 'ordinary 4xx failures require explicit manual retry');
assert.deepEqual(listQueuedCheckins(isolatedQueue, RETRY_STARTED_AT).map((row) => row.clientLocalId), ['valid-second'], 'a permanent first-row failure must not block the next queued row');
isolatedQueue = markCheckinSyncing(isolatedQueue, 'valid-second');
isolatedQueue = markCheckinSynced(isolatedQueue, 'valid-second', { status: 'visited', id: 'server-second' });
assert.equal(isolatedQueue[0].clientSyncStatus, 'failed');
assert.equal(isolatedQueue[1].clientSyncStatus, 'synced', 'the second row can finish after the first row fails permanently');
isolatedQueue = requeueCheckin(isolatedQueue, 'permanent-first');
assert.equal(isolatedQueue[0].clientSyncStatus, 'queued', 'manual retry explicitly requeues a terminal row');

const serviceUnavailable = Object.assign(new Error('service unavailable'), { status: 503 });
const retryable503 = markCheckinFailed(markCheckinSyncing(queueCheckin([], {
  ...localRow,
  clientLocalId: 'retryable-503',
  status: 'visited'
}), 'retryable-503'), 'retryable-503', serviceUnavailable, { now: RETRY_STARTED_AT });
assert.equal(retryable503[0].clientSyncRetryable, true);
assert.equal(listQueuedCheckins(retryable503, RETRY_STARTED_AT + 14_999).length, 0);
assert.equal(listQueuedCheckins(retryable503, RETRY_STARTED_AT + 15_000).length, 1, '503 becomes retryable after the backoff window');

const retryableNetwork = markCheckinFailed(markCheckinSyncing(queueCheckin([], {
  ...localRow,
  clientLocalId: 'retryable-network',
  status: 'visited'
}), 'retryable-network'), 'retryable-network', new TypeError('fetch failed'), { now: RETRY_STARTED_AT });
assert.equal(retryableNetwork[0].clientSyncRetryable, true, 'network errors without an HTTP status are retryable');
assert.equal(listQueuedCheckins(retryableNetwork, RETRY_STARTED_AT + 15_000).length, 1);

for (const status of [408, 425, 429, 500, 503]) {
  assert.equal(classifyCheckinSyncError({ status }, { now: RETRY_STARTED_AT }).retryable, true, `HTTP ${status} must be retryable`);
}
assert.equal(classifyCheckinSyncError({ status: 409 }, { now: RETRY_STARTED_AT, clientLocalId: 'idempotent-row' }).retryable, true, '409 with an idempotency key can be retried safely');
for (const status of [401, 403, 404, 422]) {
  assert.equal(classifyCheckinSyncError({ status }, { now: RETRY_STARTED_AT }).retryable, false, `HTTP ${status} must require manual retry`);
}

// rank2：服务端把未注册身份降级为 anonymous 时，返回行不得覆盖本地归属。
const anonymousEcho = markCheckinSynced(queueCheckin([], {
  ...localRow,
  clientLocalId: 'keep-local-owner',
  profileId: 'p_local_owner',
  status: 'visited'
}), 'keep-local-owner', { status: 'visited', profileId: 'anonymous', id: 'server-anon-1' });
assert.equal(anonymousEcho[0].profileId, 'p_local_owner', 'a server anonymous echo must not overwrite local ownership');

// rank2：身份类错误（未注册 / 缺 token）归类为可修复错误，保持可重试并给出引导文案。
const profileNotRegistered = Object.assign(new Error('该身份尚未在服务端注册'), { status: 403, code: 'PROFILE_NOT_REGISTERED' });
for (const code of ['PROFILE_NOT_REGISTERED', 'PROFILE_TOKEN_REQUIRED']) {
  const failure = classifyCheckinSyncError({ status: 403, code }, { now: RETRY_STARTED_AT });
  assert.equal(failure.retryable, true, `${code} must stay retryable instead of a dead end`);
  assert.equal(failure.retryAt, '2026-07-16T08:30:15.000Z');
  assert.match(failure.guidance, /身份未同步/, `${code} must carry recovery guidance`);
}
const profileBlocked = markCheckinFailed(markCheckinSyncing(queueCheckin([], {
  ...localRow,
  clientLocalId: 'profile-blocked',
  status: 'visited'
}), 'profile-blocked'), 'profile-blocked', profileNotRegistered, { now: RETRY_STARTED_AT });
assert.equal(profileBlocked[0].clientSyncRetryable, true);
assert.match(profileBlocked[0].clientSyncError, /身份未同步/, 'profile sync failures must surface the guidance text');

assert.throws(() => queueCheckin([], { status: 'visited' }), /clientLocalId/);

// 【P1 syncing 卡死】任一 flush 入口（App 挂载/online/回顾页/我的页）调用 flushAllCheckinQueues
// 时，必须先把上次刷新/关闭卡在 syncing 的行救回 queued 再取队列（服务端按 clientLocalId 幂等，
// 重复上传安全）。Node 下 api.js 依赖 import.meta.env 不可用会让后续上传中断，但恢复发生在
// 动态引入 api 之前，因此这里只断言恢复效果、吞掉上传阶段的报错。
const FLUSH_RECOVERY_KEY = 'trusted-routebook:checkins:p_flush_owner:route-flush';
const flushStorageData = new Map([[FLUSH_RECOVERY_KEY, JSON.stringify([
  { ...localRow, clientLocalId: 'stuck-syncing', clientSyncStatus: 'syncing' }
])]]);
globalThis.localStorage = /** @type {any} */ ({
  get length() { return flushStorageData.size; },
  key(index) { return [...flushStorageData.keys()][index] ?? null; },
  getItem(key) { return flushStorageData.has(key) ? flushStorageData.get(key) : null; },
  setItem(key, value) { flushStorageData.set(key, String(value)); },
  removeItem(key) { flushStorageData.delete(key); }
});
await flushAllCheckinQueues({}).catch(() => {});
const flushRecoveredRows = JSON.parse(flushStorageData.get(FLUSH_RECOVERY_KEY));
assert.equal(
  flushRecoveredRows[0].clientSyncStatus,
  'queued',
  'a flush entry point must requeue rows stuck in syncing before scanning the queue'
);
assert.equal(isCheckinFlushInFlight(), false, 'the flush in-flight flag must reset after the run');
delete globalThis.localStorage;

console.log(JSON.stringify({
  ok: true,
  queuedLocallyProcessed: true,
  retryPreservedIdentity: true,
  duplicateUploadPrevented: true,
  recoveredRows: listQueuedCheckins(recovered).length,
  permanentFailureIsolated: true,
  retryBackoffCovered: true,
  flushEntryRecoversInterrupted: true
}));

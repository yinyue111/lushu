// Owner-only account lifecycle. Admin/local bypass deliberately does not apply.
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import * as config from '../config/index.mjs';
import { createHttpError, sanitizePublicId } from '../lib/util.mjs';
import { appendJsonLine, readRecentJsonlRows, registerProfileWriteGuard, rewriteJsonlExcluding } from '../storage/jsonl.mjs';
import { getSavedProfile, getSavedRoutebook } from '../storage/records.mjs';
import { withStorageEntityLock } from '../storage/runtime.mjs';
import { cryptoRandomId, hashSecretToken, hmacText, normalizeProfileId, safeTokenEqual, sanitizeEditToken } from './tokens.mjs';
import { readCheckinPhotoContent } from '../photos/photo-content.mjs';

const OWNED_STREAMS = [
  ['routebooks', config.ROUTEBOOK_LOG_PATH],
  ['favorites', config.FAVORITE_LOG_PATH],
  ['checkins', config.CHECKIN_LOG_PATH],
  ['tripSessions', config.TRIP_SESSION_LOG_PATH],
  ['reviews', config.REVIEW_LOG_PATH],
  ['photos', config.CHECKIN_PHOTO_LOG_PATH],
  ['clicks', config.CLICK_LOG_PATH],
  ['exposures', config.EXPOSURE_LOG_PATH],
  ['aiLogs', config.AI_LOG_PATH],
  ['corrections', config.POI_CORRECTION_LOG_PATH],
  ['imports', config.IMPORT_LOG_PATH],
  ['moderation', config.MODERATION_QUEUE_LOG_PATH]
];

export function isUnavailableProfile(profile) {
  return Boolean(profile?.tombstone || profile?.deletedAt || profile?.deletionStartedAt);
}

export function withProfileMutationLock(profileId, operation) {
  return withStorageEntityLock('profile', normalizeProfileId(profileId), operation);
}

export async function assertProfileMutationActive(profileId) {
  const id = normalizeProfileId(profileId);
  if (id === 'anonymous') return;
  const profile = await getSavedProfile(id);
  if (isUnavailableProfile(profile)) throw createHttpError('该个人资料已注销', 410, 'PROFILE_DELETED');
}

export function withActiveProfileMutation(profileId, operation) {
  return withProfileMutationLock(profileId, async () => {
    await assertProfileMutationActive(profileId);
    return operation();
  });
}

export function installProfileWriteGuard() {
  registerProfileWriteGuard((profileId, operation) => withActiveProfileMutation(profileId, operation));
}

export async function requireProfileOwnerAccess(req, requestedProfileId, { allowDeleted = false } = {}) {
  const profileId = normalizeProfileId(requestedProfileId);
  const headerId = normalizeProfileId(req.headers['x-routebook-profile-id']);
  const token = sanitizeEditToken(req.headers['x-routebook-profile-token']);
  if (profileId === 'anonymous' || headerId !== profileId || !token) {
    throw createHttpError('需要匹配的个人资料 ID 和访问凭据', 403, 'PROFILE_TOKEN_REQUIRED');
  }
  const profile = await getSavedProfile(profileId);
  if (!profile) throw createHttpError('个人资料不存在或尚未同步', 404, 'PROFILE_NOT_FOUND');
  const tokenHash = hashSecretToken(token);
  if (isUnavailableProfile(profile)) {
    if (allowDeleted && safeTokenEqual(tokenHash, profile.deletionTokenHash)) return { profileId, profile, tokenHash, deleted: true };
    throw createHttpError('该个人资料已注销', 410, 'PROFILE_DELETED');
  }
  if (!safeTokenEqual(tokenHash, profile.accessTokenHash)) throw createHttpError('访问凭据无效或已撤销', 403, 'PROFILE_TOKEN_REQUIRED');
  return { profileId, profile, tokenHash, deleted: false };
}

function stripSecrets(row = {}) {
  // JSON exports must not include reusable credentials, signing material or diagnostics.
  const blocked = new Set([
    'accessTokenHash',
    'editTokenHash',
    'editToken',
    'profileAccessToken',
    'registrationCredentialHash',
    'usedRecoveryNonces',
    'deletionTokenHash',
    'revokedAccessTokenHash',
    'upstreamDetail'
  ]);
  const visit = (value) => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !blocked.has(key))
        .map(([key, child]) => [key, visit(child)])
    );
  };
  return visit(row);
}

async function collectOwnedRows(profileId) {
  return Object.fromEntries(
    await Promise.all(
      OWNED_STREAMS.map(async ([name, path]) => [
        name,
        (await readRecentJsonlRows(path, Infinity)).filter((row) => normalizeProfileId(row?.profileId) === profileId)
      ])
    )
  );
}

function photoIds(rows) {
  return [...new Set(rows.map((row) => String(row?.id ?? '')).filter((id) => config.CHECKIN_PHOTO_ID_PATTERN.test(id)))];
}

async function photoContent(photoId) {
  const content = await readCheckinPhotoContent(photoId);
  if (content) return content.bodyBuffer.toString('base64');
  throw createHttpError('照片文件缺失，导出未完成', 500, 'PHOTO_STORAGE_INTEGRITY_ERROR');
}

export async function buildProfileExport(profileId, profile) {
  const rows = await collectOwnedRows(profileId);
  const uniquePhotos = new Map(rows.photos.map((row) => [row.id, row]).reverse());
  const photos = await Promise.all(
    [...uniquePhotos.values()]
      .filter((row) => !row.tombstone && !row.deletedAt)
      .map(async (photo) => ({ ...photo, contentBase64: await photoContent(photo.id) }))
  );
  return stripSecrets({ schemaVersion: 1, exportedAt: new Date().toISOString(), profile, ...rows, photos });
}

async function appendLifecycleAudit(event, profileId, counts = {}) {
  await appendJsonLine(config.PROFILE_LIFECYCLE_LOG_PATH, {
    id: cryptoRandomId(),
    event,
    profileHash: hmacText(profileId, `${config.PROFILE_ID_SECRET}:profile-lifecycle-audit`),
    counts,
    createdAt: new Date().toISOString()
  });
}

export async function logoutProfile(req, input = {}) {
  const profileId = normalizeProfileId(input.profileId || req.headers['x-routebook-profile-id']);
  return withProfileMutationLock(profileId, async () => {
    const actor = await requireProfileOwnerAccess(req, profileId);
    if (!actor.profile.identityBound) {
      throw createHttpError('未绑定可恢复身份，撤销凭据会导致云端资料无法找回；请先导出或注销账号', 409, 'PROFILE_LOGOUT_RECOVERY_REQUIRED');
    }
    const now = new Date().toISOString();
    await appendJsonLine(config.PROFILE_LOG_PATH, { ...actor.profile, accessTokenHash: '', loggedOutAt: now, updatedAt: now }, { profileMutationLocked: true });
    await appendLifecycleAudit('logout', profileId, { revokedTokens: 1 });
    return { profileId, revoked: true };
  });
}

export async function deleteProfileData(req, input = {}) {
  if (input.confirmation !== 'DELETE') throw createHttpError('注销需明确输入 DELETE 确认', 400, 'PROFILE_DELETE_CONFIRMATION_REQUIRED');
  const profileId = normalizeProfileId(input.profileId || req.headers['x-routebook-profile-id']);
  return withProfileMutationLock(profileId, async () => {
    const actor = await requireProfileOwnerAccess(req, profileId, { allowDeleted: true });
    if (actor.profile.deletedAt) return { profileId, deleted: true, alreadyDeleted: true, deletedAt: actor.profile.deletedAt };
    const rows = await collectOwnedRows(profileId);
    const routeIds = [
      ...new Set([...(actor.profile.pendingRoutebookIds ?? []), ...rows.routebooks.map((row) => sanitizePublicId(row.id || row.publicId)).filter(Boolean)])
    ];
    const ownedPhotoIds = [...new Set([...(actor.profile.pendingPhotoIds ?? []), ...photoIds(rows.photos)])];
    const deletionStartedAt = actor.profile.deletionStartedAt || new Date().toISOString();
    const marker = {
      id: profileId,
      profileId,
      tombstone: true,
      deletionStartedAt,
      deletionTokenHash: actor.tokenHash,
      accessTokenHash: '',
      pendingRoutebookIds: routeIds,
      pendingPhotoIds: ownedPhotoIds
    };
    // Persist the full plan before erasing rows; retry after an interrupted cleanup is safe.
    await appendJsonLine(config.PROFILE_LOG_PATH, marker, { profileMutationLocked: true });
    const deletedAt = new Date().toISOString();
    const ownerProfileHash = hmacText(profileId, `${config.PROFILE_ID_SECRET}:profile-lifecycle-audit`);
    for (const id of routeIds) {
      const current = await getSavedRoutebook(id);
      if (current && normalizeProfileId(current.profileId) !== profileId && !(current.tombstone && current.ownerProfileHash === ownerProfileHash)) continue;
      if (current?.tombstone && current.ownerProfileHash === ownerProfileHash) continue;
      const version = Math.max(0, Number(current?.version) || 0) + 1;
      const tombstone = {
        id,
        publicId: id,
        tombstone: true,
        deletedAt,
        ownerProfileHash,
        version,
        parentVersion: version - 1,
        actorType: 'user',
        changeReason: '账号注销删除'
      };
      await appendJsonLine(config.ROUTEBOOK_LOG_PATH, tombstone, { profileMutationLocked: true });
      await appendJsonLine(config.ROUTEBOOK_AUDIT_LOG_PATH, { ...tombstone, event: 'profile-routebook-deleted' }, { profileMutationLocked: true });
    }
    for (const id of ownedPhotoIds) {
      await appendJsonLine(config.CHECKIN_PHOTO_LOG_PATH, { id, tombstone: true, deletedAt, ownerProfileHash }, { profileMutationLocked: true });
      for (const [, extension] of config.CHECKIN_PHOTO_EXTENSIONS) await rm(join(config.CHECKIN_PHOTO_DIR, `${id}${extension}`), { force: true });
    }
    const removedCounts = {};
    for (const [name, path] of OWNED_STREAMS) {
      removedCounts[name] = await rewriteJsonlExcluding(path, (row) => normalizeProfileId(row?.profileId) === profileId, { profileMutationLocked: true });
    }
    // Route audit history can contain full stops and creator fields; retain only minimal tombstones.
    removedCounts.routebookAudits = await rewriteJsonlExcluding(
      config.ROUTEBOOK_AUDIT_LOG_PATH,
      (row) => !row.tombstone && routeIds.includes(sanitizePublicId(row.routebookId || row.routeId || row.publicId || row.id)),
      { profileMutationLocked: true }
    );
    await rewriteJsonlExcluding(
      config.PROFILE_LOG_PATH,
      (row) => normalizeProfileId(row.id || row.profileId) === profileId && !(row.tombstone && row.deletionStartedAt === deletionStartedAt),
      { profileMutationLocked: true }
    );
    await appendJsonLine(
      config.PROFILE_LOG_PATH,
      {
        id: profileId,
        profileId,
        tombstone: true,
        deletionStartedAt,
        deletedAt,
        deletionTokenHash: actor.tokenHash,
        accessTokenHash: '',
        updatedAt: deletedAt
      },
      { profileMutationLocked: true }
    );
    // Erase the pending ID plan after final tombstone becomes durable.
    await rewriteJsonlExcluding(config.PROFILE_LOG_PATH, (row) => normalizeProfileId(row.id || row.profileId) === profileId && !row.deletedAt, {
      profileMutationLocked: true
    });
    await appendLifecycleAudit('delete', profileId, removedCounts);
    return { profileId, deleted: true, alreadyDeleted: false, deletedAt, removedCounts };
  });
}

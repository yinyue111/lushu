// Profile and review API routes.
import { createHttpError, normalizeCityName, safeDecodePathSegment, sanitizePublicId, truncateString } from '../lib/util.mjs';
import { PROFILE_LOG_PATH, REVIEW_LOG_PATH } from '../config/index.mjs';
import { appendJsonLine } from '../storage/jsonl.mjs';
import { normalizeProfileId } from '../auth/tokens.mjs';
import { getSavedProfile, getSavedReview } from '../storage/records.mjs';
import { accountOwnsProfile, resolveWriteProfile, requireLoginForWrites } from '../auth/request-access.mjs';
import { readJsonBody, sendJson } from '../http/response.mjs';
import { route } from '../http/router.mjs';
import { enforceRateLimit } from '../http/rate-limit.mjs';
import { getResolvableRoutebook } from '../routebooks/normalize.mjs';
import { buildStoredProfile, profileMutationKey } from '../auth/profiles.mjs';
import { buildProfileExport, deleteProfileData, logoutProfile, requireProfileOwnerAccess, withProfileMutationLock } from '../auth/profile-lifecycle.mjs';
import { issueProfileRecoveryCode } from '../auth/recovery-proof.mjs';
import { isPublicRoutebook, publicReviewView } from '../routebooks/views.mjs';
import { applyOpsAuditsToReview, normalizeReviewShare, reviewIsStillPublic } from '../reviews/reviews.mjs';

function normalizeStoredWishlist(raw) {
  if (!Array.isArray(raw)) return [];
  const list = [];
  const seen = new Set();
  for (const item of raw.slice(0, 80)) {
    const city = item?.city ? normalizeCityName(item.city) : '';
    const place = truncateString(String(item?.place ?? '').trim(), 48);
    if (!city || !place) continue;
    const dedupKey = `${city}:${place}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    list.push({
      id: sanitizePublicId(item?.id) || `wish-${list.length + 1}`,
      city,
      place,
      note: truncateString(String(item?.note ?? '').trim(), 120),
      createdAt: Number.isFinite(Date.parse(String(item?.createdAt ?? ''))) ? new Date(item.createdAt).toISOString() : new Date().toISOString()
    });
  }
  return list;
}

function normalizeStoredTripReminders(raw) {
  if (!Array.isArray(raw)) return [];
  const list = [];
  const seen = new Set();
  for (const item of raw.slice(0, 80)) {
    const routeId = sanitizePublicId(item?.routeId);
    const date = String(item?.date ?? '').trim();
    if (!routeId || !/^\d{4}-\d{2}-\d{2}$/.test(date) || seen.has(routeId)) continue;
    seen.add(routeId);
    list.push({
      routeId,
      title: truncateString(item?.title, 100),
      city: item?.city ? normalizeCityName(item.city) : '',
      date,
      dismissedAt: Number.isFinite(Date.parse(String(item?.dismissedAt ?? ''))) ? new Date(item.dismissedAt).toISOString() : '',
      createdAt: Number.isFinite(Date.parse(String(item?.createdAt ?? ''))) ? new Date(item.createdAt).toISOString() : new Date().toISOString()
    });
  }
  return list;
}

async function verifyAssetOwner(req, requestedProfileId) {
  const profileId = normalizeProfileId(requestedProfileId || req.headers['x-routebook-profile-id']);
  if (!profileId || profileId === 'anonymous') throw createHttpError('需要登录或有效个人资料凭据', 401, 'LOGIN_REQUIRED');
  const account = await accountOwnsProfile(req, profileId);
  if (account) {
    const existing = await getSavedProfile(profileId);
    if (existing?.deletedAt || existing?.tombstone) throw createHttpError('该个人资料已注销', 410, 'PROFILE_DELETED');
    return { profileId, existing };
  }
  const actor = await requireProfileOwnerAccess(req, profileId);
  return { profileId: actor.profileId, existing: actor.profile };
}

export const profileRoutes = [
  route('GET', '/api/profile/assets', async ({ req, res, url }) => {
    enforceRateLimit(req, 'public-read');
    const { profileId, existing } = await verifyAssetOwner(req, url.searchParams.get('profileId'));
    return sendJson(res, 200, {
      ok: true,
      profileId,
      wishlist: normalizeStoredWishlist(existing?.wishlist),
      tripReminders: normalizeStoredTripReminders(existing?.tripReminders)
    });
  }),
  route('POST', '/api/profile/assets', async ({ req, res }) => {
    await requireLoginForWrites(req);
    enforceRateLimit(req, 'core-write');
    const body = await readJsonBody(req);
    const { profileId } = await verifyAssetOwner(req, body?.profileId);
    const saved = await withProfileMutationLock(profileId, async () => {
      const current = (await getSavedProfile(profileId)) || { id: profileId, profileId, identityBound: true, createdAt: new Date().toISOString() };
      if (current.deletedAt || current.tombstone) throw createHttpError('该个人资料已注销', 410, 'PROFILE_DELETED');
      const now = new Date().toISOString();
      const next = {
        ...current,
        id: profileId,
        profileId,
        wishlist: Array.isArray(body?.wishlist) ? normalizeStoredWishlist(body.wishlist) : normalizeStoredWishlist(current.wishlist),
        tripReminders: Array.isArray(body?.tripReminders)
          ? normalizeStoredTripReminders(body.tripReminders)
          : normalizeStoredTripReminders(current.tripReminders),
        updatedAt: now
      };
      await appendJsonLine(PROFILE_LOG_PATH, next, { profileMutationLocked: true });
      return next;
    });
    return sendJson(res, 200, {
      ok: true,
      profileId,
      wishlist: saved.wishlist,
      tripReminders: saved.tripReminders
    });
  }),
  route('POST', '/api/profile', async ({ req, res }) => {
    enforceRateLimit(req);
    const body = await readJsonBody(req);
    // Signed-in accounts already own a server profile: confirm the id, never mint a second profile.
    const accountProfileId = normalizeProfileId(body?.id || body?.profileId);
    if (await accountOwnsProfile(req, accountProfileId)) return sendJson(res, 200, { ok: true, profile: { id: accountProfileId } });
    await requireLoginForWrites(req);
    // 同一 profile 的「读旧行-合并-追加」需要互斥，否则并发更新会彼此覆盖。
    const profileLockKey = await profileMutationKey(body);
    const publicProfile = await withProfileMutationLock(profileLockKey, async () => {
      const { storedProfile, publicProfile: builtProfile } = await buildStoredProfile(body);
      await appendJsonLine(PROFILE_LOG_PATH, storedProfile);
      return builtProfile;
    });
    return sendJson(res, 200, { ok: true, profile: publicProfile });
  }),
  route('GET', '/api/profile/export', async ({ req, res, url }) => {
    enforceRateLimit(req, 'core-write');
    const profileId = normalizeProfileId(url.searchParams.get('profileId') || req.headers['x-routebook-profile-id']);
    const profileExport = await withProfileMutationLock(profileId, async () => {
      const actor = await requireProfileOwnerAccess(req, profileId);
      return buildProfileExport(actor.profileId, actor.profile);
    });
    return sendJson(res, 200, { ok: true, export: profileExport });
  }),
  route('POST', '/api/profile/recovery-code', async ({ req, res }) => {
    enforceRateLimit(req, 'core-write');
    const body = await readJsonBody(req);
    const actor = await requireProfileOwnerAccess(req, body.profileId);
    return sendJson(res, 200, { ok: true, ...issueProfileRecoveryCode(actor.profile) });
  }),
  route('POST', '/api/profile/logout', async ({ req, res }) => {
    enforceRateLimit(req, 'core-write');
    return sendJson(res, 200, { ok: true, ...(await logoutProfile(req, await readJsonBody(req))) });
  }),
  route('DELETE', '/api/profile', async ({ req, res }) => {
    enforceRateLimit(req, 'core-write');
    return sendJson(res, 200, { ok: true, ...(await deleteProfileData(req, await readJsonBody(req))) });
  }),
  route('POST', '/api/reviews', async ({ req, res }) => {
    await requireLoginForWrites(req);
    enforceRateLimit(req, 'core-write');
    const body = await readJsonBody(req);
    const routeId = sanitizePublicId(body?.routebookId || body?.routeId || body?.publicId || body?.routebook?.publicId || body?.routebook?.id);
    if (!routeId) throw createHttpError('请提供公开路书 ID', 400, 'REVIEW_ROUTE_REQUIRED');
    const currentRoutebook = await getResolvableRoutebook(routeId);
    if (!currentRoutebook || !isPublicRoutebook(currentRoutebook)) {
      throw createHttpError('路书公开发布后才能生成回顾分享页', 403, 'REVIEW_ROUTE_NOT_PUBLIC');
    }
    const requestedProfileId = normalizeProfileId(body?.profileId);
    const actor = await resolveWriteProfile(req, requestedProfileId);
    if (!actor.verified) throw createHttpError('生成个人回顾需要 profile token', 403, 'PROFILE_TOKEN_REQUIRED');
    const review = await normalizeReviewShare(body, currentRoutebook, {
      profileId: actor.profileId,
      includePersistedProfileCheckins: true
    });
    await appendJsonLine(REVIEW_LOG_PATH, review);
    return sendJson(res, 200, { ok: true, review: publicReviewView(review), shareUrl: `/review/${review.publicId}` });
  }),
  route('GET', '/api/reviews/:id', async ({ req, res, params }) => {
    enforceRateLimit(req, 'public-read');
    const id = sanitizePublicId(safeDecodePathSegment(params.id));
    const review = await getSavedReview(id);
    if (!review || review.tombstone || review.deletedAt) throw createHttpError('路线回顾不存在或尚未保存', 404, 'REVIEW_NOT_FOUND');
    if (!isPublicRoutebook(review.routebook) || !(await reviewIsStillPublic(review))) {
      throw createHttpError('路线回顾已失效', 404, 'REVIEW_NOT_FOUND');
    }
    return sendJson(res, 200, { ok: true, review: publicReviewView(await applyOpsAuditsToReview(review)) });
  })
];

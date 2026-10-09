// Profile and review API routes.
import { createHttpError, safeDecodePathSegment, sanitizePublicId } from '../lib/util.mjs';
import { PROFILE_LOG_PATH, REVIEW_LOG_PATH } from '../config/index.mjs';
import { appendJsonLine } from '../storage/jsonl.mjs';
import { normalizeProfileId } from '../auth/tokens.mjs';
import { getSavedReview } from '../storage/records.mjs';
import { resolveWriteProfile } from '../auth/request-access.mjs';
import { readJsonBody, sendJson } from '../http/response.mjs';
import { route } from '../http/router.mjs';
import { enforceRateLimit } from '../http/rate-limit.mjs';
import { getResolvableRoutebook } from '../routebooks/normalize.mjs';
import { buildStoredProfile, profileMutationKey } from '../auth/profiles.mjs';
import { buildProfileExport, deleteProfileData, logoutProfile, requireProfileOwnerAccess, withProfileMutationLock } from '../auth/profile-lifecycle.mjs';
import { issueProfileRecoveryCode } from '../auth/recovery-proof.mjs';
import { isPublicRoutebook, publicReviewView } from '../routebooks/views.mjs';
import { applyOpsAuditsToReview, normalizeReviewShare, reviewIsStillPublic } from '../reviews/reviews.mjs';

export const profileRoutes = [
  route('POST', '/api/profile', async ({ req, res }) => {
    enforceRateLimit(req);
    const body = await readJsonBody(req);
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

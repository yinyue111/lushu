// Manual re-verification of persisted routes is an audited operator action.
import { route } from '../http/router.mjs';
import { bindRequestAbortSignal, readJsonBody, sendJson } from '../http/response.mjs';
import { resolveWriteProfile, verifyAdminAccess, requireLoginForWrites } from '../auth/request-access.mjs';
import { enforceRateLimit } from '../http/rate-limit.mjs';
import { createHttpError, safeDecodePathSegment, sanitizePublicId } from '../lib/util.mjs';
import { getSavedRoutebook } from '../storage/records.mjs';
import { withStorageEntityLock } from '../storage/runtime.mjs';
import { appendVersionedRoutebook, routebookMutationMetadata } from '../routebooks/versions.mjs';
import { normalizeRoutebookForStorage } from '../routebooks/normalize.mjs';
import { attachServerRouteLegs } from '../routing/service.mjs';
import { summarizeRouteExecution } from '../routing/routeExecution.mjs';
import { enrichRoutebook } from '../trust/feedback.mjs';
import { PUBLIC_ROUTE_STATUSES } from '../config/index.mjs';
import { canOverwriteRoutebook } from '../routebooks/mutations.mjs';
import { recheckOwnerRoutebook } from '../routing/ownerRecheck.mjs';
import { sanitizeEditToken } from '../auth/tokens.mjs';

/**
 * @param {Record<string, any>} routebook
 * @param {{ expectedLegs: number, unverifiedLegs: number, allVerified: boolean }} routing
 */
export function routingWarningFor(routebook, routing) {
  if (!PUBLIC_ROUTE_STATUSES.has(routebook?.publishStatus) || !routing.expectedLegs || routing.allVerified) return null;
  return {
    unverifiedLegs: routing.unverifiedLegs,
    expectedLegs: routing.expectedLegs,
    detectedAt: routebook?.routingWarning?.detectedAt || new Date().toISOString()
  };
}

export const routingRoutes = [
  route('POST', '/api/routebooks/:id/routing', async ({ req, res, params }) => {
    verifyAdminAccess(req);
    enforceRateLimit(req, 'ai');
    const id = sanitizePublicId(safeDecodePathSegment(params.id));
    const body = await readJsonBody(req);
    const signal = bindRequestAbortSignal(req);
    const updated = await withStorageEntityLock('routebook', id, async () => {
      const current = await getSavedRoutebook(id);
      if (!current) throw createHttpError('路书不存在或尚未保存', 404, 'ROUTEBOOK_NOT_FOUND');
      const version = await routebookMutationMetadata(current, body, { changeReason: '重新核验道路', actorType: 'admin' });
      // Only legs touched since the last verification are re-queried.
      const routed = await attachServerRouteLegs(normalizeRoutebookForStorage(current, id), signal, undefined, { reuseVerifiedLegs: true });
      const routing = summarizeRouteExecution(routed.stops, routed.routeLegs);
      // A re-check never unpublishes: unverified legs on a public routebook become a
      // warning for the author and ops; ops can still unpublish manually with a note.
      const routebook = normalizeRoutebookForStorage({ ...routed, ...version, routingWarning: routingWarningFor(current, routing) }, id);
      await appendVersionedRoutebook(routebook, 'routing-checked', {
        routing: summarizeRouteExecution(routebook.stops, routebook.routeLegs),
        ...(routebook.routingWarning ? { routingWarning: routebook.routingWarning } : {})
      });
      return routebook;
    });
    return sendJson(res, 200, { ok: true, routebook: await enrichRoutebook(updated) });
  }),
  // Owner self-service: re-geocode replaced/moved stops and re-verify the legs they touch.
  // Drafts only (public routebooks are re-checked by ops above); rate-limited (AMap quota).
  route('POST', '/api/routebooks/:id/recheck', async ({ req, res, params }) => {
    await requireLoginForWrites(req);
    enforceRateLimit(req, 'recheck');
    const id = sanitizePublicId(safeDecodePathSegment(params.id));
    const body = await readJsonBody(req);
    const actor = await resolveWriteProfile(req, body?.profileId);
    const signal = bindRequestAbortSignal(req);
    const result = await withStorageEntityLock('routebook', id, async () => {
      const current = await getSavedRoutebook(id);
      if (!current) throw createHttpError('路书不存在或尚未保存', 404, 'ROUTEBOOK_NOT_FOUND');
      if (!canOverwriteRoutebook(current, body, { verifiedProfileId: actor.verified ? actor.profileId : '' })) {
        throw createHttpError('只能核验自己保存的路书', 403, 'ROUTEBOOK_OWNER_REQUIRED');
      }
      if ((current.publishStatus || 'draft') !== 'draft') {
        throw createHttpError('已提交或已公开的路书由运营重新核验', 409, 'ROUTEBOOK_RECHECK_DRAFT_ONLY');
      }
      const version = await routebookMutationMetadata(current, body, { changeReason: '重新定位并核验道路', actorType: 'user' });
      const stopIds = Array.isArray(body?.stopIds) ? body.stopIds.slice(0, 50).map((value) => String(value).slice(0, 80)) : null;
      const checked = await recheckOwnerRoutebook(normalizeRoutebookForStorage(current, id), signal, { stopIds });
      const routebook = normalizeRoutebookForStorage({ ...checked.routebook, ...version, editToken: sanitizeEditToken(current.editToken) }, id);
      const summary = {
        geocoded: checked.geocoded,
        unresolved: checked.unresolved,
        geocodingConfigured: checked.geocodingConfigured,
        routing: checked.routing
      };
      await appendVersionedRoutebook(routebook, 'owner-rechecked', summary);
      return { routebook, summary };
    });
    const enriched = await enrichRoutebook(result.routebook);
    return sendJson(res, 200, { ok: true, routebook: { ...enriched, ownerAccessVerified: actor.verified }, recheck: result.summary });
  })
];

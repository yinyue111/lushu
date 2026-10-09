// Manual re-verification of persisted routes is an audited operator action.
import { route } from '../http/router.mjs';
import { bindRequestAbortSignal, readJsonBody, sendJson } from '../http/response.mjs';
import { verifyAdminAccess } from '../auth/request-access.mjs';
import { enforceRateLimit } from '../http/rate-limit.mjs';
import { createHttpError, safeDecodePathSegment, sanitizePublicId } from '../lib/util.mjs';
import { getSavedRoutebook } from '../storage/records.mjs';
import { withStorageEntityLock } from '../storage/runtime.mjs';
import { appendVersionedRoutebook, routebookMutationMetadata } from '../routebooks/versions.mjs';
import { normalizeRoutebookForStorage } from '../routebooks/normalize.mjs';
import { attachServerRouteLegs } from '../routing/service.mjs';
import { summarizeRouteExecution } from '../routing/routeExecution.mjs';
import { enrichRoutebook } from '../trust/feedback.mjs';

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
      const demoted = ['published', 'featured'].includes(current.publishStatus) && routing.expectedLegs > 0 && !routing.allVerified;
      const routebook = normalizeRoutebookForStorage({ ...routed, ...version, ...(demoted ? { publishStatus: 'pending_review' } : {}) }, id);
      await appendVersionedRoutebook(routebook, 'routing-checked', { routing: summarizeRouteExecution(routebook.stops, routebook.routeLegs) });
      return routebook;
    });
    return sendJson(res, 200, { ok: true, routebook: await enrichRoutebook(updated) });
  })
];

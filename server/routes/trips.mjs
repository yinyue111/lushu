import { safeDecodePathSegment, sanitizePublicId } from '../lib/util.mjs';
import { route } from '../http/router.mjs';
import { readJsonBody, sendJson } from '../http/response.mjs';
import { enforceRateLimit } from '../http/rate-limit.mjs';
import { requireProfileOwnerAccess } from '../auth/profile-lifecycle.mjs';
import { getTripSessionSnapshot, requireTripSessionRouteAccess, saveTripSessionSnapshot } from '../trips/sessions.mjs';

export const tripRoutes = [
  route('GET', '/api/trip-sessions/:id', async ({ req, res, url, params }) => {
    enforceRateLimit(req, 'public-read');
    const actor = await requireProfileOwnerAccess(req, url.searchParams.get('profileId'));
    const routeId = sanitizePublicId(safeDecodePathSegment(params.id));
    await requireTripSessionRouteAccess(routeId, actor.profileId);
    return sendJson(res, 200, { ok: true, session: await getTripSessionSnapshot(routeId, actor.profileId) });
  }),
  route('POST', '/api/trip-sessions/:id', async ({ req, res, params }) => {
    enforceRateLimit(req, 'core-write');
    const body = await readJsonBody(req);
    const actor = await requireProfileOwnerAccess(req, body.profileId);
    const session = await saveTripSessionSnapshot(sanitizePublicId(safeDecodePathSegment(params.id)), body, actor);
    return sendJson(res, 200, { ok: true, session });
  })
];

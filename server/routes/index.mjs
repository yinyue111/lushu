// API entry: route table + error handling.
import { systemRoutes } from './system.mjs';
import { poiRoutes } from './poi.mjs';
import { routebookRoutes } from './routebooks.mjs';
import { profileRoutes } from './profiles.mjs';
import { aiRoutes } from './ai.mjs';
import { checkinRoutes } from './checkins.mjs';
import { opsRoutes } from './ops.mjs';
import { routingRoutes } from './routing.mjs';
import { tripRoutes } from './trips.mjs';
import { refreshPoiCatalog } from '../poi/catalog.mjs';
import { refreshModerationState } from '../moderation/index.mjs';
import { createRouter } from '../http/router.mjs';
import { createHttpError } from '../lib/util.mjs';
import { sendJson } from '../http/response.mjs';

const apiRoutes = [
  ...systemRoutes,
  ...poiRoutes,
  ...routebookRoutes,
  ...profileRoutes,
  ...aiRoutes,
  ...checkinRoutes,
  ...opsRoutes,
  ...routingRoutes,
  ...tripRoutes
];

const apiRouter = createRouter(apiRoutes);

/**
 * Builds the API entry. The POI catalog freshness check (a TTL-bounded reload
 * of the merged seed + ops POI catalog, a full stream read under PostgreSQL)
 * only runs for routes that may resolve POIs; health probes, map tiles, city
 * lists and read-only ops listings opt out with `route(..., { poiCatalog: false })`.
 * Unknown paths (404) never touch the catalog either.
 *
 * @param {{ router: ReturnType<typeof createRouter>, refreshCatalog: () => Promise<unknown> }} deps
 */
export function createApiHandler({ router, refreshCatalog }) {
  return async function apiHandler(req, res) {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      // M5: table-driven routing with exact path-segment matching (`:id` never spans '/').
      const matched = router.match(req.method, url.pathname);
      if (!matched) throw createHttpError('接口不存在', 404, 'API_NOT_FOUND');
      if (matched.route.poiCatalog) await refreshCatalog();
      return await matched.route.handler({ req, res, url, params: matched.params });
    } catch (error) {
      return sendApiError(req, res, error);
    }
  };
}

export const handleApi = createApiHandler({ router: apiRouter, refreshCatalog: () => Promise.all([refreshPoiCatalog(), refreshModerationState()]) });

function sendApiError(req, res, error) {
  if (error.upstreamDetail) {
    console.error(
      `[model] requestId=${req.requestId ?? 'unknown'} status=${error.upstreamStatus ?? error.statusCode ?? 500} code=${error.upstreamCode ?? error.code ?? 'MODEL_ERROR'}`
    );
  } else if ((error.statusCode ?? 500) >= 500) {
    console.error(`[server] requestId=${req.requestId ?? 'unknown'} status=${error.statusCode ?? 500} code=${error.code ?? 'SERVER_ERROR'}`);
  }
  if (Number.isFinite(error.retryAfterSeconds) && !res.headersSent) res.setHeader('Retry-After', String(error.retryAfterSeconds));
  return sendJson(res, error.statusCode ?? 500, {
    error: error.statusCode ? (error.message ?? '服务器错误') : '服务器暂时不可用，请稍后重试',
    code: error.code ?? 'SERVER_ERROR',
    ...(error.currentVersion != null ? { currentVersion: error.currentVersion } : {}),
    ...(Number.isFinite(error.retryAfterSeconds) ? { retryAfterSeconds: error.retryAfterSeconds } : {})
  });
}

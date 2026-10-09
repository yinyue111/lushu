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

export async function handleApi(req, res) {
  try {
    await refreshPoiCatalog();
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    // M5: table-driven routing with exact path-segment matching (`:id` never spans '/').
    const matched = apiRouter.match(req.method, url.pathname);
    if (matched) return await matched.route.handler({ req, res, url, params: matched.params });
    throw createHttpError('接口不存在', 404, 'API_NOT_FOUND');
  } catch (error) {
    if (error.upstreamDetail) {
      console.error(
        `[model] requestId=${req.requestId ?? 'unknown'} status=${error.upstreamStatus ?? error.statusCode ?? 500} code=${error.upstreamCode ?? error.code ?? 'MODEL_ERROR'}`
      );
    } else if ((error.statusCode ?? 500) >= 500) {
      console.error(`[server] requestId=${req.requestId ?? 'unknown'} status=${error.statusCode ?? 500} code=${error.code ?? 'SERVER_ERROR'}`);
    }
    return sendJson(res, error.statusCode ?? 500, {
      error: error.statusCode ? (error.message ?? '服务器错误') : '服务器暂时不可用，请稍后重试',
      code: error.code ?? 'SERVER_ERROR',
      ...(error.currentVersion != null ? { currentVersion: error.currentVersion } : {})
    });
  }
}

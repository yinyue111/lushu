// 内测埋点：激活漏斗（客户端两步）与前端错误上报。超限静默 204，同其它埋点。
import { route } from '../http/router.mjs';
import { readJsonBody, sendJson } from '../http/response.mjs';
import { consumeRateLimit, sendTelemetryThrottled } from '../http/rate-limit.mjs';
import { CLIENT_FUNNEL_EVENTS, recordClientError, recordFunnelEvent } from '../analytics/funnelEvents.mjs';
import { createHttpError, truncateString } from '../lib/util.mjs';
import { normalizeProfileId } from '../auth/tokens.mjs';

export const telemetryRoutes = [
  route('POST', '/api/funnel-events', async ({ req, res }) => {
    if (!consumeRateLimit(req, 'telemetry')) return sendTelemetryThrottled(req, res);
    const body = await readJsonBody(req);
    const event = truncateString(body?.event, 40);
    // 注册、分享打开只能由服务端记录，客户端不能伪造。
    if (!CLIENT_FUNNEL_EVENTS.has(event)) throw createHttpError('不支持的漏斗事件', 400, 'FUNNEL_EVENT_INVALID');
    await recordFunnelEvent(event, { profileId: normalizeProfileId(body?.profileId) });
    return sendJson(res, 200, { ok: true });
  }),
  route('POST', '/api/client-errors', async ({ req, res }) => {
    if (!consumeRateLimit(req, 'telemetry')) return sendTelemetryThrottled(req, res);
    const body = await readJsonBody(req);
    await recordClientError(body);
    return sendJson(res, 200, { ok: true });
  })
];

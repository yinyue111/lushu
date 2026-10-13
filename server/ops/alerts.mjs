// 运营告警：配置了 ALERT_WEBHOOK_URL 就 POST 一条 JSON（同类每小时最多一次），没配只写日志。
// 不带用户内容，只带告警类型、简短说明和时间。
const lastSent = new Map();
const HOUR_MS = 3_600_000;

export function alertWebhookUrl() {
  const url = String(process.env.ALERT_WEBHOOK_URL ?? '').trim();
  return /^https?:\/\//.test(url) ? url : '';
}

/** @param {string} type @param {string} message @param {{ now?: number, fetchImpl?: typeof fetch }} [options] */
/** @returns {Promise<any>} */
export async function raiseAlert(type, message, { now = Date.now(), fetchImpl = globalThis.fetch } = {}) {
  console.warn(`[alert] ${type}: ${message}`);
  const last = lastSent.get(type);
  if (last && now - last < HOUR_MS) return { sent: false, reason: 'throttled' };
  lastSent.set(type, now);
  const url = alertWebhookUrl();
  if (!url) return { sent: false, reason: 'no-webhook' };
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type, message, at: new Date(now).toISOString(), service: 'lushu' }),
      signal: AbortSignal.timeout(5000)
    });
    return { sent: response.ok, status: response.status };
  } catch (error) {
    console.warn('[alert] webhook failed', type, String(error?.message ?? error));
    return { sent: false, reason: 'webhook-failed' };
  }
}

export function resetAlertThrottleForTests() {
  lastSent.clear();
}

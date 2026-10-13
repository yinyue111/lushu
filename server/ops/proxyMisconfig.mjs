// Runtime safeguard for a proxy misconfiguration the startup check cannot see: Caddy runs in a
// container (or anywhere) whose address is NOT in TRUSTED_PROXY_CIDRS, so forwarded headers are
// ignored and every user is rate-limited as the proxy's single address.
// Signal: a request carries a forwarded header the app reads (X-Forwarded-For / X-Forwarded-Proto)
// while its TCP peer is not a trusted proxy. Counted per process in a rolling window (minute buckets);
// the app runs as one process per deployment (docs/deploy.md), so there is nothing to aggregate.
import { envNumber } from '../config/env.mjs';
import { raiseAlert } from './alerts.mjs';
import { TRUST_PROXY_HEADERS } from '../config/index.mjs';
import { isTrustedProxyAddress } from '../auth/request-access.mjs';

const MINUTE = 60_000;
const FORWARDED_HEADERS = ['x-forwarded-for', 'x-forwarded-proto'];
export const PROXY_MISCONFIG_ALERT_TYPE = 'proxy-misconfig';

/**
 * @param {{ enabled: boolean, isTrusted: (peer: string) => boolean, threshold?: number, windowMs?: number,
 *   logIntervalMs?: number, now?: () => number, warn?: (msg: string) => void,
 *   alert?: (type: string, message: string) => unknown }} options
 */
export function createProxyMisconfigMonitor({
  enabled,
  isTrusted,
  threshold = 20,
  windowMs = 10 * MINUTE,
  logIntervalMs = 10 * MINUTE,
  now = Date.now,
  warn = (msg) => console.warn(msg),
  alert = (type, message) => raiseAlert(type, message)
}) {
  const buckets = new Map(); // minute index -> count
  let total = 0;
  let lastPeer = '';
  let lastSeenAt = 0;
  let lastLogAt = -Infinity;
  let logged = 0;
  let lastAlertAt = -Infinity;
  const ALERT_EVERY_MS = 3_600_000;

  const prune = (t) => {
    const oldest = Math.floor((t - windowMs) / MINUTE);
    for (const key of buckets.keys()) if (key <= oldest) buckets.delete(key);
  };
  const windowCount = (t = now()) => {
    prune(t);
    let n = 0;
    for (const v of buckets.values()) n += v;
    return n;
  };

  /** @param {{ headers: Record<string, any>, socket?: { remoteAddress?: string } }} req */
  function observe(req) {
    if (!enabled) return false;
    if (!FORWARDED_HEADERS.some((h) => String(req.headers?.[h] ?? '').trim())) return false;
    const peer = String(req.socket?.remoteAddress ?? '');
    if (isTrusted(peer)) return false;
    const t = now();
    const key = Math.floor(t / MINUTE);
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
    total += 1;
    lastPeer = peer;
    lastSeenAt = t;
    const count = windowCount(t);
    if (t - lastLogAt >= logIntervalMs) {
      lastLogAt = t;
      logged += 1;
      warn(
        `[proxy] WARNING: request with forwarded headers from untrusted peer ${peer || 'unknown'} (${count} in the last ${Math.round(windowMs / MINUTE)} min). ` +
          'If the reverse proxy runs at this address, add it to TRUSTED_PROXY_CIDRS (docs/deploy.md「Caddy 两种部署方式」); otherwise all users share one rate-limit bucket.'
      );
    }
    if (count >= threshold && t - lastAlertAt >= ALERT_EVERY_MS) {
      lastAlertAt = t;
      Promise.resolve(
        alert(
          PROXY_MISCONFIG_ALERT_TYPE,
          `代理配置疑似有误：${count} 个请求带转发头但来自不受信任的地址 ${peer || 'unknown'}（近 ${Math.round(windowMs / MINUTE)} 分钟），所有用户可能共用限流额度。请检查 TRUSTED_PROXY_CIDRS / PROXY_MODE。`
        )
      ).catch(() => {});
    }
    return true;
  }

  function state() {
    const count = windowCount();
    return {
      count,
      threshold,
      windowMs,
      tripped: count >= threshold,
      lastPeer,
      lastSeenAt: lastSeenAt ? new Date(lastSeenAt).toISOString() : null,
      total,
      logged
    };
  }

  return { observe, state };
}

let defaultMonitor = null;
/** The process-wide monitor (TRUST_PROXY_HEADERS / TRUSTED_PROXY_CIDRS from the app config). */
export function proxyMisconfigMonitor() {
  defaultMonitor ??= createProxyMisconfigMonitor({
    enabled: TRUST_PROXY_HEADERS,
    isTrusted: isTrustedProxyAddress,
    threshold: envNumber('PROXY_MISCONFIG_THRESHOLD', 20, { min: 1 }),
    windowMs: envNumber('PROXY_MISCONFIG_WINDOW_MS', 10 * MINUTE, { min: MINUTE })
  });
  return defaultMonitor;
}

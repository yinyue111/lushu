// Runtime safeguard for a proxy misconfiguration the startup check cannot see: Caddy runs in a
// container (or anywhere) whose address is NOT in TRUSTED_PROXY_CIDRS, so forwarded headers are
// ignored and every user is rate-limited as the proxy's single address.
// Signal: a request carries a forwarded header the app reads (X-Forwarded-For / X-Forwarded-Proto)
// while its TCP peer is not a trusted proxy. Counted per process in a rolling window (minute buckets);
// the app runs as one process per deployment (docs/deploy.md), so there is nothing to aggregate.
// Second signal (container mode, traffic reaching Caddy through docker-proxy, e.g. IPv6 or iptables:false):
// Caddy itself only sees the network gateway, so the resolved client address of almost every
// forwarded request IS the gateway. Flag when >= sharedRatio of them resolve to APP_NETWORK_GATEWAY,
// with at least sharedMinSample forwarded requests in the window (low traffic never trips it).
import { envNumber } from '../config/env.mjs';
import { raiseAlert } from './alerts.mjs';
import { TRUST_PROXY_HEADERS } from '../config/index.mjs';
import { isTrustedProxyAddress, requestClientKey } from '../auth/request-access.mjs';

const MINUTE = 60_000;
const FORWARDED_HEADERS = ['x-forwarded-for', 'x-forwarded-proto'];
export const PROXY_MISCONFIG_ALERT_TYPE = 'proxy-misconfig';
const plainAddress = (a) =>
  String(a ?? '')
    .trim()
    .replace(/^::ffff:/i, '');

/**
 * @param {{ enabled: boolean, isTrusted: (peer: string) => boolean, threshold?: number, windowMs?: number,
 *   logIntervalMs?: number, now?: () => number, warn?: (msg: string) => void,
 *   alert?: (type: string, message: string) => unknown, gateway?: string, resolveClient?: (req: any) => string,
 *   sharedMinSample?: number, sharedRatio?: number }} options
 */
export function createProxyMisconfigMonitor({
  enabled,
  isTrusted,
  threshold = 20,
  windowMs = 10 * MINUTE,
  logIntervalMs = 10 * MINUTE,
  now = Date.now,
  warn = (msg) => console.warn(msg),
  alert = (type, message) => raiseAlert(type, message),
  gateway = '',
  resolveClient = () => '',
  sharedMinSample = 20,
  sharedRatio = 0.9
}) {
  const gatewayAddr = plainAddress(gateway);
  const buckets = new Map(); // minute index -> { untrusted, samples, gateway }
  let total = 0;
  let lastPeer = '';
  let lastSeenAt = 0;
  let sharedLastSeenAt = 0;
  let lastLogAt = -Infinity;
  let logged = 0;
  let lastAlertAt = -Infinity;
  const ALERT_EVERY_MS = 3_600_000;

  const prune = (t) => {
    const oldest = Math.floor((t - windowMs) / MINUTE);
    for (const key of buckets.keys()) if (key <= oldest) buckets.delete(key);
  };
  const sums = (t = now()) => {
    prune(t);
    const out = { untrusted: 0, samples: 0, gateway: 0 };
    for (const v of buckets.values()) {
      out.untrusted += v.untrusted;
      out.samples += v.samples;
      out.gateway += v.gateway;
    }
    return out;
  };
  const bucket = (t) => {
    const key = Math.floor(t / MINUTE);
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { untrusted: 0, samples: 0, gateway: 0 }));
    return b;
  };
  const sharedTripped = (x) => Boolean(gatewayAddr) && x.samples >= sharedMinSample && x.gateway / x.samples >= sharedRatio;
  const maybeAlert = (t, message) => {
    if (t - lastAlertAt < ALERT_EVERY_MS) return;
    lastAlertAt = t;
    Promise.resolve(alert(PROXY_MISCONFIG_ALERT_TYPE, message)).catch(() => {});
  };

  /** @param {{ headers: Record<string, any>, socket?: { remoteAddress?: string } }} req */
  function observe(req) {
    if (!enabled) return false;
    if (!FORWARDED_HEADERS.some((h) => String(req.headers?.[h] ?? '').trim())) return false;
    const peer = String(req.socket?.remoteAddress ?? '');
    const t = now();
    const mins = Math.round(windowMs / MINUTE);
    if (isTrusted(peer)) {
      if (!gatewayAddr) return false;
      // Only sample requests whose forwarded chain names at least one untrusted (client) address. A chain of
      // trusted addresses only (e.g. Caddy's `X-Forwarded-For: 127.0.0.1` for on-server loopback requests) makes
      // the resolver fall back to the TCP peer, i.e. the gateway in host mode: not a shared-address symptom.
      const chain = String(req.headers?.['x-forwarded-for'] ?? '')
        .split(',')
        .map((e) => e.trim())
        .filter(Boolean);
      if (!chain.some((e) => !isTrusted(e))) return false;
      const b = bucket(t);
      b.samples += 1;
      if (plainAddress(resolveClient(req)) === gatewayAddr) {
        b.gateway += 1;
        sharedLastSeenAt = t;
      }
      const x = sums(t);
      if (sharedTripped(x))
        maybeAlert(
          t,
          `疑似所有用户被识别成同一个地址：近 ${mins} 分钟 ${x.samples} 个经代理的请求里 ${x.gateway} 个的来源是网关 ${gatewayAddr}，可能共用限流额度。请检查 Caddy 看到的来源（docker-proxy / IPv6 / iptables）。`
        );
      return false;
    }
    bucket(t).untrusted += 1;
    total += 1;
    lastPeer = peer;
    lastSeenAt = t;
    const count = sums(t).untrusted;
    if (t - lastLogAt >= logIntervalMs) {
      lastLogAt = t;
      logged += 1;
      warn(
        `[proxy] WARNING: request with forwarded headers from untrusted peer ${peer || 'unknown'} (${count} in the last ${mins} min). ` +
          'If the reverse proxy runs at this address, add it to TRUSTED_PROXY_CIDRS (docs/deploy.md「Caddy 两种部署方式」); otherwise all users share one rate-limit bucket.'
      );
    }
    if (count >= threshold)
      maybeAlert(
        t,
        `代理配置疑似有误：${count} 个请求带转发头但来自不受信任的地址 ${peer || 'unknown'}（近 ${mins} 分钟），所有用户可能共用限流额度。请检查 TRUSTED_PROXY_CIDRS / PROXY_MODE。`
      );
    return true;
  }

  function state() {
    const x = sums();
    const count = x.untrusted;
    return {
      count,
      shared: {
        samples: x.samples,
        gatewayHits: x.gateway,
        ratio: x.samples ? x.gateway / x.samples : null,
        minSample: sharedMinSample,
        threshold: sharedRatio,
        gateway: gatewayAddr || null,
        lastSeenAt: sharedLastSeenAt ? new Date(sharedLastSeenAt).toISOString() : null,
        tripped: sharedTripped(x)
      },
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
    windowMs: envNumber('PROXY_MISCONFIG_WINDOW_MS', 10 * MINUTE, { min: MINUTE }),
    gateway: process.env.APP_NETWORK_GATEWAY,
    resolveClient: requestClientKey,
    sharedMinSample: envNumber('PROXY_SHARED_MIN_SAMPLE', 20, { min: 1 })
  });
  return defaultMonitor;
}

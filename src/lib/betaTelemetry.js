// 内测埋点（激活漏斗）与前端错误上报。都走 fetch keepalive，失败静默，不影响页面。
import { getProfile } from './profile.js';

function send(path, body) {
  try {
    const payload = JSON.stringify(body);
    const url = `/api${path}`;
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload, keepalive: true, credentials: 'same-origin' }).catch(() => {});
  } catch {
    /* ignore */
  }
}

/** 每个会话每个事件只记一次。 @param {'home_view' | 'create_start'} event */
export function trackFunnel(event) {
  try {
    const key = `lushu:funnel:${event}`;
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, '1');
  } catch {
    /* 无 sessionStorage 时照常发一次 */
  }
  send('/funnel-events', { event, profileId: getProfile()?.id || '' });
}

/**
 * 信任行为埋点（不去重，按次数）：route_view / confirm_open / source_open / fact_report / share_copy。
 * @param {string} event @param {string} [ref]
 */
export function trackEvent(event, ref = '') {
  send('/funnel-events', { event, ref: String(ref).slice(0, 40), profileId: getProfile()?.id || '' });
}

const OPENED_KEY = 'lushu:opened-routebooks';
/** 打开路书：记一次 route_view；同一份路书隔天再打开记 revisit（只在本机记日期，不上传）。 @param {string} routeId */
export function trackRouteOpen(routeId) {
  if (!routeId) return;
  const today = new Date().toISOString().slice(0, 10);
  let seen = {};
  try {
    seen = JSON.parse(localStorage.getItem(OPENED_KEY) || '{}') || {};
  } catch {
    seen = {};
  }
  const last = seen[routeId];
  if (last === today) return;
  trackEvent('route_view', routeId);
  if (last && last < today) trackEvent('revisit', routeId);
  seen[routeId] = today;
  const keep = Object.entries(seen)
    .sort((a, b) => (a[1] < b[1] ? 1 : -1))
    .slice(0, 50);
  try {
    localStorage.setItem(OPENED_KEY, JSON.stringify(Object.fromEntries(keep)));
  } catch {
    /* ignore */
  }
}

let reported = 0;
const seen = new Set();
/** @param {'render' | 'error' | 'unhandledrejection'} kind @param {any} error */
export function reportClientError(kind, error) {
  const message = String(error?.message ?? error ?? '').slice(0, 500);
  const signature = `${kind}:${message}`;
  if (reported >= 5 || seen.has(signature)) return; // 每个页面最多 5 条，同一条只报一次
  seen.add(signature);
  reported += 1;
  send('/client-errors', {
    kind,
    message,
    stack: String(error?.stack ?? '').slice(0, 1500),
    url: window.location.pathname,

    userAgent: navigator.userAgent
  });
}

export function installGlobalErrorReporting() {
  window.addEventListener('error', (event) => reportClientError('error', event.error || event.message));
  window.addEventListener('unhandledrejection', (event) => reportClientError('unhandledrejection', event.reason));
}

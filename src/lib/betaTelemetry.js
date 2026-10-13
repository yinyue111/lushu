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

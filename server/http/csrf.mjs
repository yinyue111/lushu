// CSRF guard for cookie-authenticated writes. Header-token callers were never exposed (a cross-site page
// cannot set custom headers without CORS, which this API never grants); the login cookie is sent
// automatically, so state-changing requests that carry it must come from this site.
import { PUBLIC_BASE_URL } from '../config/index.mjs';
import { createHttpError } from '../lib/util.mjs';
import { hasSessionCookie } from '../accounts/session.mjs';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function sameOriginByHeaders(req) {
  const site = String(req.headers['sec-fetch-site'] ?? '').toLowerCase();
  if (site) return site === 'same-origin' || site === 'none';
  const origin = String(req.headers.origin ?? '');
  if (!origin) return true; // no browser signals at all: not a browser, so it cannot hold the victim's cookie
  try {
    const { host } = new URL(origin);
    if (host && host === String(req.headers.host ?? '')) return true;
    return Boolean(PUBLIC_BASE_URL) && new URL(PUBLIC_BASE_URL).host === host;
  } catch {
    return false;
  }
}

export function assertSameOriginWrite(req) {
  if (SAFE_METHODS.has(String(req.method ?? 'GET').toUpperCase())) return;
  if (!hasSessionCookie(req)) return;
  if (!sameOriginByHeaders(req)) throw createHttpError('请求来源不对，请刷新页面后重试', 403, 'CSRF_REJECTED');
}

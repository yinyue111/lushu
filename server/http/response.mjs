// HTTP response helpers: security headers, request ids, JSON responses and bodies.
import { IS_PRODUCTION, MAX_JSON_BODY_BYTES } from '../config/index.mjs';
import { cryptoRandomId } from '../auth/tokens.mjs';
import { createHttpError } from '../lib/util.mjs';

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), payment=()'
};
const STATIC_CONNECT_SOURCES = ["'self'", ...(!IS_PRODUCTION ? ['http://127.0.0.1:*', 'ws://127.0.0.1:*'] : [])];
export const STATIC_SECURITY_HEADERS = {
  ...SECURITY_HEADERS,
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${STATIC_CONNECT_SOURCES.join(' ')}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'"
  ].join('; ')
};

export function securityHeaders(extra = {}) {
  return {
    ...SECURITY_HEADERS,
    ...extra
  };
}

export function assignRequestId(req, res) {
  const requestId = cryptoRandomId();
  req.requestId = requestId;
  res.requestId = requestId;
  res.setHeader('x-request-id', requestId);
  return requestId;
}

export function requestIdHeaders(res) {
  return res.requestId ? { 'x-request-id': res.requestId } : {};
}

export function sendJson(res, statusCode, payload) {
  const responsePayload =
    res.requestId && payload && typeof payload === 'object' && !Array.isArray(payload) ? { ...payload, requestId: res.requestId } : payload;
  const body = JSON.stringify(responsePayload);
  res.writeHead(statusCode, {
    ...securityHeaders(),
    ...requestIdHeaders(res),
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(body);
}

export async function readJsonBody(req, maxBytes = MAX_JSON_BODY_BYTES) {
  const bodyLimit = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : MAX_JSON_BODY_BYTES;
  const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
  if (contentType && !contentType.includes('application/json')) {
    throw createHttpError('请求 Content-Type 必须是 application/json', 415, 'UNSUPPORTED_MEDIA_TYPE');
  }

  const declaredLength = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > bodyLimit) {
    throw createHttpError('请求体过大', 413, 'PAYLOAD_TOO_LARGE');
  }

  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    totalBytes += chunk.byteLength;
    if (totalBytes > bodyLimit) {
      throw createHttpError('请求体过大', 413, 'PAYLOAD_TOO_LARGE');
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw createHttpError('请求体不是合法 JSON', 400, 'BAD_JSON');
  }
}

export function bindRequestAbortSignal(req) {
  const controller = new AbortController();
  req.on('close', () => {
    if (!req.complete) controller.abort();
  });
  return controller.signal;
}

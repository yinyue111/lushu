// Request-level access control: client address / proxy trust, API, admin and profile checks.
import {
  TRUSTED_PROXY_CIDRS,
  TRUST_PROXY_HEADERS,
  ALLOW_LOCAL_API_BYPASS,
  API_TOKEN,
  PUBLIC_MODEL_PROXY_ALLOWED,
  ADMIN_API_TOKEN,
  ALLOW_LOCAL_ADMIN_BYPASS
} from '../config/index.mjs';
import { createHttpError } from '../lib/util.mjs';
import { safeTokenEqual, hashSecretToken, normalizeProfileId, sanitizeEditToken } from './tokens.mjs';
import { getSavedProfile } from '../storage/records.mjs';
import { isIP } from 'node:net';

function isLocalAddress(address) {
  const normalized = normalizeRemoteAddress(address);
  if (!normalized) return false;
  return normalized === '::1' || (isIP(normalized) === 4 && normalized.startsWith('127.'));
}

// A loopback connection is not enough: a rebinding Host or a cross-site browser
// request must never inherit the developer's local administrator privileges.
function hasLocalRequestContext(req) {
  const host = String(req.headers.host ?? '').trim();
  if (!host || /[\s,@/\\?#]/.test(host)) return false;
  const protocol = req.socket.encrypted ? 'https:' : 'http:';
  try {
    const target = new URL(`${protocol}//${host}`);
    const hostname = target.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (hostname !== 'localhost' && !isLocalAddress(hostname)) return false;
    if (String(req.headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') return false;
    const origin = req.headers.origin;
    if (origin == null) return true;
    // Compare serialized origins without accepting paths, userinfo, or 'null'.
    return String(origin) === target.origin;
  } catch {
    return false;
  }
}

function normalizeRemoteAddress(address) {
  const value = String(address ?? '').trim();
  if (!value) return '';
  if (value.startsWith('::ffff:')) return value.slice('::ffff:'.length);
  return value;
}

function ipv4ToNumber(address) {
  const parts = String(address ?? '').split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const value = Number(part);
    if (value < 0 || value > 255) return null;
    result = (result << 8) + value;
  }
  return result >>> 0;
}

function ipv4MatchesCidr(address, cidr) {
  const [range, prefixText = '32'] = String(cidr ?? '').split('/');
  const addressNumber = ipv4ToNumber(address);
  const rangeNumber = ipv4ToNumber(range);
  const prefix = Number(prefixText);
  if (addressNumber == null || rangeNumber == null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return false;
  }
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (addressNumber & mask) === (rangeNumber & mask);
}

function isTrustedProxyAddress(address) {
  const normalized = normalizeRemoteAddress(address);
  if (!normalized) return false;
  return TRUSTED_PROXY_CIDRS.some((entry) => {
    if (entry.includes('/')) return ipv4MatchesCidr(normalized, entry);
    return normalizeRemoteAddress(entry) === normalized;
  });
}

// Proxies append to X-Forwarded-For, so the leftmost hop is attacker-controlled.
// Walk from the right and stop at the first address that is not a known proxy.
function forwardedClientAddress(req) {
  const chain = String(req.headers['x-forwarded-for'] ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    if (!isTrustedProxyAddress(chain[index])) return chain[index];
  }
  return '';
}

function hasForwardedChain(req) {
  return Boolean(String(req.headers['x-forwarded-for'] ?? '').trim());
}

export function shouldTrustProxyHeaders(req) {
  return TRUST_PROXY_HEADERS && isTrustedProxyAddress(req.socket.remoteAddress);
}

// Local-only bypasses must never be derived from a request header. Behind a
// same-host reverse proxy every request arrives from 127.0.0.1, so a forwarded
// chain is proof the client is remote regardless of what the header claims.
export function isLocalRequest(req) {
  if (shouldTrustProxyHeaders(req) && hasForwardedChain(req)) return false;
  return isLocalAddress(req.socket.remoteAddress) && hasLocalRequestContext(req);
}

export function requestClientKey(req) {
  if (shouldTrustProxyHeaders(req)) {
    const forwardedFor = forwardedClientAddress(req);
    if (forwardedFor) return forwardedFor;
  }
  return req.socket.remoteAddress || 'unknown';
}

export function verifyApiAccess(req) {
  if (isLocalRequest(req) && ALLOW_LOCAL_API_BYPASS) return;

  const providedToken = String(req.headers['x-routebook-token'] ?? '').trim();
  // No access code configured at all: remote callers cannot use the model on this deployment.
  if (!PUBLIC_MODEL_PROXY_ALLOWED || !API_TOKEN) {
    throw createHttpError('这个站点暂未开放在线生成。', 403, 'LOCAL_ONLY');
  }
  // An access code is configured: tell the user exactly what to do.
  if (!providedToken) {
    throw createHttpError('需要访问码：请在「高级设置」里填写访问码后再试。', 403, 'ACCESS_CODE_REQUIRED');
  }
  if (!safeTokenEqual(providedToken, API_TOKEN)) {
    throw createHttpError('访问码不对：请在「高级设置」里检查后重新填写。', 403, 'ACCESS_CODE_INVALID');
  }
}

/**
 * Whether this caller could actually use the model endpoints right now.
 * - open: local bypass, or the public proxy is enabled and the access code matches
 * - needs-access-code: the public proxy is enabled but no/invalid access code was sent
 * - disabled: remote callers cannot generate on this deployment at all
 * @param {import('node:http').IncomingMessage} req
 * @returns {'open' | 'needs-access-code' | 'disabled'}
 */
export function apiAccessState(req) {
  if (isLocalRequest(req) && ALLOW_LOCAL_API_BYPASS) return 'open';
  if (!PUBLIC_MODEL_PROXY_ALLOWED || !API_TOKEN) return 'disabled';
  const providedToken = String(req.headers['x-routebook-token'] ?? '').trim();
  return safeTokenEqual(providedToken, API_TOKEN) ? 'open' : 'needs-access-code';
}

export function verifyAdminAccess(req) {
  if (isLocalRequest(req) && ALLOW_LOCAL_ADMIN_BYPASS) return;

  const providedToken = String(req.headers['x-routebook-admin-token'] ?? '').trim();
  if (!safeTokenEqual(providedToken, ADMIN_API_TOKEN)) {
    throw createHttpError('需要运营管理员令牌', 403, 'ADMIN_TOKEN_REQUIRED');
  }
}

export function hasAdminAccess(req) {
  try {
    verifyAdminAccess(req);
    return true;
  } catch {
    return false;
  }
}

export function verifySensitiveReadAccess(req) {
  if (isLocalRequest(req) && ALLOW_LOCAL_ADMIN_BYPASS) return;
  verifyAdminAccess(req);
}

export async function verifyProfileReadAccess(req, profileId) {
  const id = normalizeProfileId(profileId);
  if (!id || id === 'anonymous') return false;
  const profile = await getSavedProfile(id);
  if (
    !profile ||
    profile.tombstone ||
    profile.deletedAt ||
    profile.deletionStartedAt ||
    profile.deletingAt ||
    profile.status === 'deleted' ||
    profile.status === 'deleting'
  )
    return false;
  if (isLocalRequest(req) && ALLOW_LOCAL_ADMIN_BYPASS) return true;
  if (hasAdminAccess(req)) return true;
  const headerProfileId = normalizeProfileId(req.headers['x-routebook-profile-id']);
  const token = sanitizeEditToken(req.headers['x-routebook-profile-token']);
  if (headerProfileId !== id || !token) return false;
  return safeTokenEqual(hashSecretToken(token), profile?.accessTokenHash);
}

export async function resolveWriteProfile(req, requestedProfileId, { requireRegistered = false } = {}) {
  const profileId = normalizeProfileId(requestedProfileId);
  if (!profileId || profileId === 'anonymous') {
    return { profileId: 'anonymous', verified: false, identityBound: false };
  }
  const profile = await getSavedProfile(profileId);
  if (profile && (await verifyProfileReadAccess(req, profileId))) {
    return { profileId, verified: true, identityBound: profile?.identityBound === true };
  }
  if (profile) {
    throw createHttpError('写入该用户数据需要 profile token', 403, 'PROFILE_TOKEN_REQUIRED');
  }
  // requireRegistered（目前仅打卡使用）：未注册 profile 不再静默降级为
  // anonymous——降级会让客户端误以为打卡已计入个人主页与可信分。
  if (requireRegistered) {
    throw createHttpError('该 profile 尚未在服务端注册，请先同步或重建个人资料后再打卡', 403, 'PROFILE_NOT_REGISTERED');
  }
  return { profileId: 'anonymous', verified: false, identityBound: false };
}

export async function verifySensitiveOrProfileReadAccess(req, profileId) {
  if (profileId && (await verifyProfileReadAccess(req, profileId))) return;
  verifySensitiveReadAccess(req);
}

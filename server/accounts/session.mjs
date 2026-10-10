// Login sessions: an opaque random sid in an httpOnly cookie; only sha256(sid) is stored.
import { createHash, randomBytes } from 'node:crypto';
import { AUTH_COOKIE_SECURE, AUTH_SESSION_MAX_DAYS, AUTH_SESSION_TTL_DAYS } from '../config/index.mjs';
import { accountStore } from './store.mjs';

const DAY = 24 * 60 * 60 * 1000;
const TOUCH_EVERY_MS = 60 * 60 * 1000;
// __Host- needs Secure, Path=/ and no Domain. Browsers treat http://localhost as secure, so dev works too.
export const SESSION_COOKIE = AUTH_COOKIE_SECURE ? '__Host-lushu_sid' : 'lushu_sid';
const SID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const hashSid = (sid) => createHash('sha256').update(`sid:v1:${sid}`).digest('hex');

export function readSessionCookie(req) {
  const header = String(req.headers.cookie ?? '');
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(index + 1).trim();
    return SID_PATTERN.test(value) ? value : '';
  }
  return '';
}

export function hasSessionCookie(req) {
  return String(req.headers.cookie ?? '').includes(`${SESSION_COOKIE}=`);
}

function cookie(value, maxAgeSeconds) {
  return [`${SESSION_COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`, ...(AUTH_COOKIE_SECURE ? ['Secure'] : [])].join('; ');
}

function appendSetCookie(res, value) {
  const existing = res.getHeader?.('set-cookie');
  const list = Array.isArray(existing) ? existing : existing ? [String(existing)] : [];
  res.setHeader('set-cookie', [...list, value]);
}

export function clearSessionCookie(res) {
  appendSetCookie(res, cookie('', 0));
}

/** Starts a fresh session (always a new sid: login, registration, password change and claim rotate). */
export async function startSession(req, res, user, now = Date.now()) {
  const previous = readSessionCookie(req);
  if (previous) await accountStore().revokeSession(hashSid(previous));
  const sid = randomBytes(32).toString('base64url');
  const absoluteExpiresAt = new Date(now + AUTH_SESSION_MAX_DAYS * DAY).toISOString();
  const expiresAt = new Date(Math.min(now + AUTH_SESSION_TTL_DAYS * DAY, Date.parse(absoluteExpiresAt))).toISOString();
  const session = {
    sidHash: hashSid(sid),
    userId: user.id,
    createdAt: new Date(now).toISOString(),
    lastSeenAt: new Date(now).toISOString(),
    expiresAt,
    absoluteExpiresAt,
    userAgent: String(req.headers['user-agent'] ?? '').slice(0, 120)
  };
  await accountStore().createSession(session);
  appendSetCookie(res, cookie(sid, Math.floor((Date.parse(absoluteExpiresAt) - now) / 1000)));
  req.authSession = Promise.resolve({ session, user });
  return session;
}

/**
 * Resolves the request's session once per request. Returns { session, user } or null.
 * Expired, revoked, or disabled/deleted accounts resolve to null.
 */
export function resolveSession(req, now = Date.now()) {
  req.authSession ??= (async () => {
    const sid = readSessionCookie(req);
    if (!sid) return null;
    const store = accountStore();
    const session = await store.getSession(hashSid(sid));
    if (!session || session.revokedAt) return null;
    if (Date.parse(session.expiresAt) <= now || Date.parse(session.absoluteExpiresAt) <= now) return null;
    const user = await store.getUser(session.userId);
    if (!user || user.status !== 'active') return null;
    if (now - Date.parse(session.lastSeenAt) > TOUCH_EVERY_MS) {
      const expiresAt = new Date(Math.min(now + AUTH_SESSION_TTL_DAYS * DAY, Date.parse(session.absoluteExpiresAt))).toISOString();
      await store.touchSession(session.sidHash, { lastSeenAt: new Date(now).toISOString(), expiresAt });
    }
    return { session, user };
  })();
  return req.authSession;
}

export async function endSession(req, res) {
  const sid = readSessionCookie(req);
  if (sid) await accountStore().revokeSession(hashSid(sid));
  clearSessionCookie(res);
  req.authSession = Promise.resolve(null);
}

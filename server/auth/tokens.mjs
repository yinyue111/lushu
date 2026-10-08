// Token/secret helpers: constant-time comparison, HMAC/hash, id + edit-token minting.
import { randomBytes, timingSafeEqual, createHmac, randomUUID } from 'node:crypto';
import { sanitizePublicId } from '../lib/util.mjs';
import { PROFILE_ID_SECRET } from '../config/index.mjs';

export function normalizeProfileId(value) {
  const id = sanitizePublicId(value);
  return id || 'anonymous';
}

export function createRouteEditToken() {
  return randomBytes(24).toString('base64url');
}

export function createServerProfileId() {
  return `p_${cryptoRandomId()
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 24)}`;
}

export function sanitizeEditToken(value) {
  return String(value ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 96);
}

export function safeEqualHex(a, b) {
  if (!/^[a-f0-9]{64}$/i.test(a) || !/^[a-f0-9]{64}$/i.test(b)) return false;
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function safeTokenEqual(provided, expected) {
  const providedText = String(provided ?? '');
  const expectedText = String(expected ?? '');
  if (!providedText || !expectedText) return false;
  const left = Buffer.from(providedText);
  const right = Buffer.from(expectedText);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function hmacText(value, secret = PROFILE_ID_SECRET) {
  return createHmac('sha256', String(secret || 'trusted-routebook'))
    .update(String(value ?? ''))
    .digest('hex')
    .slice(0, 18);
}

export function hashSecretToken(value) {
  const token = sanitizeEditToken(value);
  return token ? hmacText(token, `${PROFILE_ID_SECRET}:profile-token`) : '';
}

export function cryptoRandomId() {
  if (typeof randomUUID === 'function') return randomUUID();
  return randomBytes(16).toString('hex');
}

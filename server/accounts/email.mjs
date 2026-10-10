// Emails are personal data: stored as an HMAC (lookup/uniqueness), AES-256-GCM ciphertext (so we can
// send mail) and a mask (for display). The plain address is never written to storage or logs.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { AUTH_EMAIL_ENC_KEY, AUTH_EMAIL_HASH_SECRET } from '../config/index.mjs';

const FULLWIDTH = /[\uff01-\uff5e]/g;
export const EMAIL_MAX_LENGTH = 254;

/** Trim, full-width → half-width, lowercase. Returns '' when it does not look like an email. */
export function normalizeEmail(value) {
  const text = String(value ?? '')
    .replace(FULLWIDTH, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\u3002/g, '.')
    .trim()
    .toLowerCase();
  if (!text || text.length > EMAIL_MAX_LENGTH) return '';
  const at = text.lastIndexOf('@');
  if (at < 1 || text.indexOf('@') !== at) return '';
  const local = text.slice(0, at);
  const domain = text.slice(at + 1);
  if (local.length > 64 || /[\s<>()[\]\\,;:"]/.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return '';
  if (!/^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) return '';
  return text;
}

/** Whether an identifier typed into the login box is meant as an email. */
export const looksLikeEmail = (value) => String(value ?? '').includes('@') || String(value ?? '').includes('＠');

export function maskEmail(email) {
  const [local, domain] = String(email ?? '').split('@');
  if (!local || !domain) return '';
  const shown = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return `${shown}***@${domain}`;
}

export function emailHash(email) {
  if (!AUTH_EMAIL_HASH_SECRET) throw Object.assign(new Error('AUTH_EMAIL_HASH_SECRET is not configured'), { code: 'AUTH_NOT_CONFIGURED' });
  return createHmac('sha256', AUTH_EMAIL_HASH_SECRET).update(`email:v1:${email}`).digest('hex');
}

const encKey = () => {
  if (!AUTH_EMAIL_ENC_KEY) throw Object.assign(new Error('AUTH_EMAIL_ENC_KEY is not configured'), { code: 'AUTH_NOT_CONFIGURED' });
  return createHash('sha256').update(`email-enc:v1:${AUTH_EMAIL_ENC_KEY}`).digest();
};

/** 'v1.<iv>.<tag>.<ciphertext>' (base64url). */
export function encryptEmail(email) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encKey(), iv);
  const data = Buffer.concat([cipher.update(String(email), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}

export function decryptEmail(value) {
  const [version, iv, tag, data] = String(value ?? '').split('.');
  if (version !== 'v1' || !iv || !tag || !data) return '';
  try {
    const decipher = createDecipheriv('aes-256-gcm', encKey(), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

/** Fields stored on a user for a (normalized) email. */
export const emailFields = (email, verifiedAt = null) => ({
  emailHash: emailHash(email),
  emailEnc: encryptEmail(email),
  emailMasked: maskEmail(email),
  emailVerifiedAt: verifiedAt
});

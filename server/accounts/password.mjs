// Password hashing with node:crypto scrypt. Versioned strings let parameters change later:
//   scrypt$v1$<logN>$<r>$<p>$<salt b64url>$<hash b64url>
import { scrypt as scryptCallback, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import { AUTH_PASSWORD_PEPPER, AUTH_SCRYPT_CONCURRENCY } from '../config/index.mjs';
import { createHttpError } from '../lib/util.mjs';

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 72;
const CURRENT = { version: 'v1', logN: 15, r: 8, p: 1, keyLength: 64 };
const MAXMEM = 96 * 1024 * 1024;

// Small built-in list of the most common passwords (lower-cased). Enough to stop the obvious ones.
const COMMON = new Set(
  `12345678 123456789 1234567890 11111111 00000000 88888888 66666666 12341234 11223344 87654321 qwertyui qwerty123
  password password1 password123 iloveyou 1qaz2wsx qazwsxedc abc12345 abcd1234 a1234567 aa123456 a12345678 woaini1314
  5201314520 woaini520 147258369 123123123 123qweasd qweasdzxc zxcvbnm123 admin123 admin888 asdfghjkl 1q2w3e4r 1q2w3e4r5t
  999999999 12121212 147852369 159357456 789456123 456789123 1314520520 qq123456 aaaaaaaa abcdefgh`.split(/\s+/)
);

/** Returns an error code, or '' when the password is acceptable. */
export function passwordPolicyError(password, { phone = '' } = {}) {
  const text = String(password ?? '');
  const length = [...text].length;
  if (length < PASSWORD_MIN) return 'PASSWORD_TOO_SHORT';
  if (length > PASSWORD_MAX) return 'PASSWORD_TOO_LONG';
  const lower = text.toLowerCase();
  if (COMMON.has(lower) || /^(.)\1+$/.test(text)) return 'PASSWORD_TOO_COMMON';
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (digits.length >= 8 && text.includes(digits.slice(-8))) return 'PASSWORD_CONTAINS_PHONE';
  return '';
}

export const PASSWORD_POLICY_COPY = {
  PASSWORD_TOO_SHORT: `密码至少 ${PASSWORD_MIN} 位`,
  PASSWORD_TOO_LONG: `密码最多 ${PASSWORD_MAX} 位`,
  PASSWORD_TOO_COMMON: '这个密码太常见，换一个',
  PASSWORD_CONTAINS_PHONE: '密码里别带手机号'
};

export function assertPasswordPolicy(password, options) {
  const code = passwordPolicyError(password, options);
  if (code) throw createHttpError(PASSWORD_POLICY_COPY[code], 400, code);
}

// Bounded concurrency: each hash takes ~32 MB, so a login flood must queue instead of exhausting memory.
let active = 0;
const waiting = [];
const MAX_QUEUE = 64;
async function withSlot(operation) {
  if (active >= AUTH_SCRYPT_CONCURRENCY) {
    if (waiting.length >= MAX_QUEUE) throw createHttpError('登录的人有点多，稍后再试', 429, 'AUTH_BUSY');
    await new Promise((resolve) => waiting.push(resolve));
  }
  active += 1;
  try {
    return await operation();
  } finally {
    active -= 1;
    waiting.shift()?.();
  }
}

function peppered(password) {
  const text = String(password ?? '').normalize('NFKC');
  return AUTH_PASSWORD_PEPPER ? createHmac('sha256', AUTH_PASSWORD_PEPPER).update(text).digest() : Buffer.from(text);
}

function derive(password, salt, { logN, r, p, keyLength }) {
  return withSlot(
    () =>
      new Promise((resolve, reject) => {
        scryptCallback(peppered(password), salt, keyLength, { N: 2 ** logN, r, p, maxmem: MAXMEM }, (error, key) => (error ? reject(error) : resolve(key)));
      })
  );
}

export async function hashPassword(password, params = CURRENT) {
  const salt = randomBytes(16);
  const key = await derive(password, salt, params);
  return ['scrypt', params.version, params.logN, params.r, params.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

function parse(stored) {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 7 || parts[0] !== 'scrypt' || parts[1] !== 'v1') return null;
  const [logN, r, p] = parts.slice(2, 5).map(Number);
  if (![logN, r, p].every(Number.isSafeInteger) || logN < 10 || logN > 20 || r < 1 || r > 32 || p < 1 || p > 4) return null;
  const salt = Buffer.from(parts[5], 'base64url');
  const key = Buffer.from(parts[6], 'base64url');
  if (salt.length < 16 || key.length < 32) return null;
  return { version: 'v1', logN, r, p, keyLength: key.length, salt, key };
}

// A fixed, valid hash so unknown phones cost the same as wrong passwords.
let dummyHash = '';
async function dummy() {
  dummyHash ||= await hashPassword(randomBytes(12).toString('hex'));
  return dummyHash;
}

/** Constant-work verification. Pass stored='' for unknown accounts. */
export async function verifyPassword(password, stored) {
  const parsed = parse(stored) ?? parse(await dummy());
  const key = await derive(password, parsed.salt, parsed);
  return Boolean(stored) && parse(stored) !== null && key.length === parsed.key.length && timingSafeEqual(key, parsed.key);
}

export function passwordNeedsRehash(stored) {
  const parsed = parse(stored);
  return !parsed || parsed.logN !== CURRENT.logN || parsed.r !== CURRENT.r || parsed.p !== CURRENT.p || parsed.keyLength !== CURRENT.keyLength;
}

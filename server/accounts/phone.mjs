// Phone numbers are personal data: only an HMAC (for lookup/uniqueness) and a mask (for display) are stored.
import { createHmac } from 'node:crypto';
import { AUTH_PHONE_HASH_SECRET } from '../config/index.mjs';

const FULLWIDTH_DIGITS = /[０-９]/g;

/** Normalizes a mainland China mobile number to E.164 (+86…). Returns '' when it is not one. */
export function normalizePhone(value) {
  let text = String(value ?? '')
    .replace(FULLWIDTH_DIGITS, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
    .replace(/[\s\-().]/g, '')
    .replace(/^＋/, '+');
  if (text.length > 20) return '';
  if (text.startsWith('0086')) text = `+86${text.slice(4)}`;
  else if (text.startsWith('86') && text.length === 13) text = `+${text}`;
  else if (!text.startsWith('+')) text = `+86${text}`;
  return /^\+861[3-9]\d{9}$/.test(text) ? text : '';
}

export function maskPhone(e164) {
  const digits = String(e164 ?? '').replace(/^\+86/, '');
  if (!/^1\d{10}$/.test(digits)) return '';
  return `+86 ${digits.slice(0, 3)}****${digits.slice(7)}`;
}

export function phoneHash(e164) {
  if (!AUTH_PHONE_HASH_SECRET) throw Object.assign(new Error('AUTH_PHONE_HASH_SECRET is not configured'), { code: 'AUTH_NOT_CONFIGURED' });
  return createHmac('sha256', AUTH_PHONE_HASH_SECRET).update(`phone:v1:${e164}`).digest('hex');
}

/** Last four digits only, for "+86 1xx****1234"-style ops search. */
export function phoneLast4(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : '';
}

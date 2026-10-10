// One-time 6-digit email codes: HMAC-stored, 15 min, single use, 5 tries per code, bound to purpose + address.
import { createHmac, randomInt } from 'node:crypto';
import { PROFILE_ID_SECRET } from '../config/index.mjs';
import { createHttpError } from '../lib/util.mjs';
import { cryptoRandomId, safeEqualHex } from '../auth/tokens.mjs';
import { accountStore } from './store.mjs';
import { encryptEmail } from './email.mjs';
import { sendMail } from '../mail/transport.mjs';
import { codeMail } from '../mail/templates.mjs';
import { codeKey, lockedError, mailIpKey, mailtoKey, recordFailure, throttleState, clearThrottle } from './throttle.mjs';

export const EMAIL_CODE_TTL_MS = 15 * 60 * 1000;
export const EMAIL_CODE_MAX_ATTEMPTS = 5;
export const EMAIL_CODE_RESEND_MS = 60 * 1000;
export const EMAIL_PURPOSES = ['register', 'reset', 'change'];

const hashCode = (purpose, emailHashValue, code) =>
  createHmac('sha256', `${PROFILE_ID_SECRET}:email-code`)
    .update(`${purpose}:${emailHashValue}:${String(code)}`)
    .digest('hex');

export const normalizeEmailCode = (value) =>
  String(value ?? '')
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
    .replace(/\D/g, '')
    .slice(0, 6);

export const INVALID_CODE = () => createHttpError('验证码不对或已过期，请重新获取', 400, 'EMAIL_CODE_INVALID');

async function guard(keys) {
  for (const key of keys) {
    const state = await throttleState(key);
    if (state.locked) throw lockedError(state.lockedUntil, Date.now(), key);
  }
}

/**
 * Throttle checks for a send to this address from this client. Call before deciding what to send so
 * the answer (and the throttle) is the same whether or not the address has an account.
 */
export async function guardMailSend(req, emailHashValue) {
  await guard([mailIpKey(req), mailtoKey(emailHashValue)]);
  const latest = await Promise.all(EMAIL_PURPOSES.map((purpose) => accountStore().latestEmailCode(purpose, emailHashValue)));
  const newest = Math.max(0, ...latest.filter(Boolean).map((c) => Date.parse(c.createdAt)));
  const wait = newest + EMAIL_CODE_RESEND_MS - Date.now();
  if (wait > 0) {
    const error = createHttpError(`验证码刚发过，${Math.ceil(wait / 1000)} 秒后可以再发`, 429, 'EMAIL_CODE_TOO_SOON');
    /** @type {any} */ (error).retryAfterSeconds = Math.ceil(wait / 1000);
    throw error;
  }
  await recordFailure(mailIpKey(req));
  await recordFailure(mailtoKey(emailHashValue));
}

/** Creates a code and mails it. */
export async function issueEmailCode({ purpose, email, emailHashValue, userId = null }) {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const now = Date.now();
  await accountStore().createEmailCode({
    id: `ec_${cryptoRandomId()
      .replace(/[^A-Za-z0-9]/g, '')
      .slice(0, 20)}`,
    purpose,
    emailHash: emailHashValue,
    emailEnc: encryptEmail(email),
    userId,
    codeHash: hashCode(purpose, emailHashValue, code),
    expiresAt: new Date(now + EMAIL_CODE_TTL_MS).toISOString(),
    createdAt: new Date(now).toISOString()
  });
  await sendMail({ to: email, ...codeMail(purpose, code) });
}

/**
 * Checks a code; returns the code record on success (not yet consumed — call consumeEmailCode once the
 * action it guards succeeded). Wrong codes count against the code and the address.
 */
export async function checkEmailCode({ purpose, emailHashValue, code, userId = undefined }) {
  await guard([codeKey(emailHashValue)]);
  const typed = normalizeEmailCode(code);
  const record = await accountStore().latestEmailCode(purpose, emailHashValue);
  const usable =
    record &&
    !record.consumedAt &&
    Date.parse(record.expiresAt) > Date.now() &&
    record.attempts < EMAIL_CODE_MAX_ATTEMPTS &&
    (userId === undefined || record.userId === userId);
  const ok = usable && typed.length === 6 && safeEqualHex(hashCode(purpose, emailHashValue, typed), record.codeHash);
  if (!ok) {
    if (usable) await accountStore().updateEmailCode(record.id, { attempts: record.attempts + 1 });
    await recordFailure(codeKey(emailHashValue));
    throw INVALID_CODE();
  }
  return record;
}

export async function consumeEmailCode(record) {
  await accountStore().updateEmailCode(record.id, { consumedAt: new Date().toISOString() });
  await clearThrottle(codeKey(record.emailHash));
}

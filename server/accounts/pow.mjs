// Light human check without third parties: a short proof-of-work bound to a signed, single-use challenge.
// It slows scripted sign-ups and password guessing; it is not a CAPTCHA and does not identify anyone.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { AUTH_POW_DIFFICULTY, PROFILE_ID_SECRET } from '../config/index.mjs';
import { createHttpError } from '../lib/util.mjs';
import { safeEqualHex } from '../auth/tokens.mjs';

const TTL_MS = 5 * 60 * 1000;
const used = new Map();

function sign(body) {
  return createHmac('sha256', `${PROFILE_ID_SECRET}:auth-pow`).update(body).digest('hex');
}

export function issueChallenge(purpose, now = Date.now(), difficulty = AUTH_POW_DIFFICULTY) {
  const body = `${purpose}.${now + TTL_MS}.${difficulty}.${randomBytes(12).toString('base64url')}`;
  return { challenge: `${body}.${sign(body)}`, difficulty, expiresAt: new Date(now + TTL_MS).toISOString() };
}

export function leadingZeroBits(buffer) {
  let bits = 0;
  for (const byte of buffer) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}

export function solveChallenge(challenge, difficulty) {
  for (let nonce = 0; ; nonce += 1) {
    if (leadingZeroBits(createHash('sha256').update(`${challenge}:${nonce}`).digest()) >= difficulty) return String(nonce);
  }
}

/** Throws 400 HUMAN_CHECK_REQUIRED/INVALID unless the proof is valid, fresh and unused. */
export function assertHumanCheck(proof, purpose, now = Date.now()) {
  if (AUTH_POW_DIFFICULTY <= 0) return;
  const challenge = String(proof?.challenge ?? '');
  const nonce = String(proof?.nonce ?? '');
  if (!challenge || !/^\d{1,12}$/.test(nonce)) throw createHttpError('请稍等，正在做安全检查', 400, 'HUMAN_CHECK_REQUIRED');
  const parts = challenge.split('.');
  const invalid = () => createHttpError('安全检查已过期，请再试一次', 400, 'HUMAN_CHECK_INVALID');
  if (parts.length !== 5) throw invalid();
  const [kind, expires, difficultyText] = parts;
  const body = parts.slice(0, 4).join('.');
  const difficulty = Number(difficultyText);
  if (kind !== purpose || !(Number(expires) > now) || !safeEqualHex(parts[4], sign(body)) || difficulty < AUTH_POW_DIFFICULTY) throw invalid();
  if (leadingZeroBits(createHash('sha256').update(`${challenge}:${nonce}`).digest()) < difficulty) throw invalid();
  for (const [key, expiry] of used) if (expiry <= now) used.delete(key);
  if (used.has(challenge)) throw invalid();
  used.set(challenge, Number(expires));
}

import { createHmac, randomBytes } from 'node:crypto';
import { PROFILE_ID_SECRET } from '../config/index.mjs';
import { safeEqualHex } from './tokens.mjs';
import { createHttpError } from '../lib/util.mjs';

const RECOVERY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function signature(profile, nonce, expiresAt) {
  return createHmac('sha256', PROFILE_ID_SECRET).update(`recovery-v2:${profile.id}:${profile.accessTokenHash}:${nonce}:${expiresAt}`).digest('hex');
}

export function issueProfileRecoveryCode(profile, now = Date.now()) {
  const nonce = randomBytes(16).toString('base64url');
  const expiresAt = new Date(now + RECOVERY_TTL_MS).toISOString();
  const payload = { version: 2, profileId: profile.id, nonce, expiresAt, proof: signature(profile, nonce, expiresAt) };
  return { recoveryCode: `trb1_${Buffer.from(JSON.stringify(payload)).toString('base64url')}`, expiresAt };
}

export function consumeProfileRecoveryProof(profile, input = {}, now = Date.now()) {
  const used = Array.isArray(profile?.usedRecoveryNonces) ? profile.usedRecoveryNonces.slice(-20) : [];
  const nonce = String(input.recoveryNonce ?? '');
  const expiresAt = String(input.recoveryExpiresAt ?? '');
  const proof = String(input.recoveryProof ?? '').toLowerCase();
  if (!nonce && !expiresAt && !proof) return { recovered: false, usedRecoveryNonces: used };
  if (!profile || !/^[A-Za-z0-9_-]{16,80}$/.test(nonce) || !safeEqualHex(proof, signature(profile, nonce, expiresAt))) {
    // A consumed nonce is checked separately because recovery rotated the token.
    if (used.includes(nonce)) throw createHttpError('恢复码已使用，请重新生成', 403, 'RECOVERY_CODE_USED');
    throw createHttpError('恢复码无效或已损坏', 403, 'RECOVERY_CODE_INVALID');
  }
  if (used.includes(nonce)) throw createHttpError('恢复码已使用，请重新生成', 403, 'RECOVERY_CODE_USED');
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now || expiresAtMs > now + RECOVERY_TTL_MS + 1000) {
    throw createHttpError('恢复码已过期，请重新生成', 403, 'RECOVERY_CODE_EXPIRED');
  }
  return { recovered: true, usedRecoveryNonces: [...used, nonce].slice(-20) };
}

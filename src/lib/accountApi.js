// Account API (email or phone + password). The session lives in an httpOnly cookie the page never sees.
import { getJson, postJson } from './api.js';

export const getAuthConfig = (signal) => getJson('/auth/config', signal);
export const getMe = (signal) => getJson('/auth/me', signal);

function hexLeadingZeroBits(bytes) {
  let bits = 0;
  for (const byte of bytes) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}

/**
 * Light human check: find a nonce whose sha256(challenge:nonce) starts with `difficulty` zero bits.
 * Takes well under a second on a phone at the default difficulty; yields to keep the page responsive.
 */
export async function solveHumanCheck(purpose, signal) {
  const { challenge, difficulty } = await getJson(`/auth/challenge?purpose=${encodeURIComponent(purpose)}`, signal);
  const encoder = new TextEncoder();
  for (let nonce = 0; nonce < 50_000_000; nonce += 1) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(`${challenge}:${nonce}`)));
    if (hexLeadingZeroBits(digest) >= difficulty) return { challenge, nonce: String(nonce) };
    if (nonce % 2000 === 1999) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('安全检查没有完成，请再试一次');
}

/** Sign-up step 1: mail a 6-digit code to the address. */
export async function sendRegisterCode(email, signal) {
  const humanCheck = await solveHumanCheck('mail', signal);
  return postJson('/auth/register/code', { email, humanCheck }, signal);
}

export async function register({ email, emailCode, phone, password, inviteCode, acceptPrivacy, deviceProfile }, signal) {
  const humanCheck = await solveHumanCheck('register', signal);
  return postJson('/auth/register', { email, emailCode, phone, password, inviteCode, acceptPrivacy, deviceProfile, humanCheck }, signal);
}

/** Logs in with a phone number or an email; solves the human check only when the server asks for it. */
export async function login({ identifier, password }, signal) {
  try {
    return await postJson('/auth/login', { identifier, password }, signal);
  } catch (error) {
    if (error?.code !== 'HUMAN_CHECK_REQUIRED') throw error;
    const humanCheck = await solveHumanCheck('login', signal);
    return postJson('/auth/login', { identifier, password, humanCheck }, signal);
  }
}

/** Forgot password step 1: mail a reset code (same answer whether or not the address has an account). */
export async function sendResetCode(email, signal) {
  const humanCheck = await solveHumanCheck('mail', signal);
  return postJson('/auth/reset-password/code', { email, humanCheck }, signal);
}

export const resetPasswordWithEmail = ({ email, emailCode, password }, signal) => postJson('/auth/reset-password', { email, emailCode, password }, signal);

export async function resetPassword({ identifier, recoveryCode, password }, signal) {
  const humanCheck = await solveHumanCheck('reset', signal);
  return postJson('/auth/reset-password', { identifier, recoveryCode, password, humanCheck }, signal);
}

export const sendChangeEmailCode = (email, password, signal) => postJson('/auth/email/code', { email, password }, signal);
export const confirmChangeEmail = (email, emailCode, signal) => postJson('/auth/email', { email, emailCode }, signal);

export const logout = (signal) => postJson('/auth/logout', {}, signal);
export const logoutAll = (signal) => postJson('/auth/logout-all', {}, signal);
export const changePassword = (currentPassword, password, signal) => postJson('/auth/password', { currentPassword, password }, signal);
export const regenerateRecoveryCodes = (password, signal) => postJson('/auth/recovery-codes', { password }, signal);
export const claimDeviceData = (body, signal) => postJson('/auth/claim', body, signal);
export const deleteAccount = (password, signal) => postJson('/auth/delete', { password }, signal);
export const exportAccount = (signal) => getJson('/auth/export', signal);

// Phone + password account API. The session lives in an httpOnly cookie the page never sees.
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

export async function register({ phone, password, inviteCode, acceptPrivacy, deviceProfile }, signal) {
  const humanCheck = await solveHumanCheck('register', signal);
  return postJson('/auth/register', { phone, password, inviteCode, acceptPrivacy, deviceProfile, humanCheck }, signal);
}

/** Logs in; solves the human check only when the server asks for it. */
export async function login({ phone, password }, signal) {
  try {
    return await postJson('/auth/login', { phone, password }, signal);
  } catch (error) {
    if (error?.code !== 'HUMAN_CHECK_REQUIRED') throw error;
    const humanCheck = await solveHumanCheck('login', signal);
    return postJson('/auth/login', { phone, password, humanCheck }, signal);
  }
}

export async function resetPassword({ phone, recoveryCode, password }, signal) {
  const humanCheck = await solveHumanCheck('reset', signal);
  return postJson('/auth/reset-password', { phone, recoveryCode, password, humanCheck }, signal);
}

export const logout = (signal) => postJson('/auth/logout', {}, signal);
export const logoutAll = (signal) => postJson('/auth/logout-all', {}, signal);
export const changePassword = (currentPassword, password, signal) => postJson('/auth/password', { currentPassword, password }, signal);
export const regenerateRecoveryCodes = (password, signal) => postJson('/auth/recovery-codes', { password }, signal);
export const claimDeviceData = (body, signal) => postJson('/auth/claim', body, signal);
export const deleteAccount = (password, signal) => postJson('/auth/delete', { password }, signal);
export const exportAccount = (signal) => getJson('/auth/export', signal);

// Admin-managed invite codes (several at once, each with a note, use limit and expiry; revocable).
// Only an HMAC of the code is stored; the plain code is shown once when it is created.
import { createHmac, randomBytes } from 'node:crypto';
import { PROFILE_ID_SECRET } from '../config/index.mjs';
import { adminStore } from './store.mjs';

export const inviteCodeHash = (code) =>
  createHmac('sha256', PROFILE_ID_SECRET)
    .update(`invite:v1:${String(code).trim().toUpperCase()}`)
    .digest('hex');

export function generateInviteCode() {
  // 10 chars from an unambiguous alphabet, e.g. "K7QM-4XPR2"
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(10);
  const raw = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

export async function findLiveInvite(code, now = Date.now()) {
  const hash = inviteCodeHash(code);
  const invite = (await adminStore().listInvites()).find((i) => i.codeHash === hash);
  if (!invite || invite.revokedAt || (invite.expiresAt && Date.parse(invite.expiresAt) <= now) || invite.used >= invite.maxUses) return null;
  return invite;
}

export async function consumeInviteCode(codeHash) {
  return adminStore().consumeInvite(codeHash);
}

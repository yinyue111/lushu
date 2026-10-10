// One-time recovery codes. Shown once; only HMACs are stored. Format: XXXX-XXXX-XXXX (no 0/O/1/I/L/U).
import { createHmac, randomInt } from 'node:crypto';
import { PROFILE_ID_SECRET } from '../config/index.mjs';
import { safeEqualHex } from '../auth/tokens.mjs';

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
export const RECOVERY_CODE_COUNT = 6;

export function normalizeRecoveryCode(value) {
  return String(value ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 24);
}
export const hashRecoveryCode = (code) => createHmac('sha256', `${PROFILE_ID_SECRET}:account-recovery`).update(normalizeRecoveryCode(code)).digest('hex');

export function generateRecoveryCode() {
  const chars = Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}`;
}

/** @returns {{ codes: string[], hashes: { hash: string, usedAt: null, source: string, issuedAt: string }[] }} */
export function issueRecoveryCodes(count = RECOVERY_CODE_COUNT, source = 'user') {
  const issuedAt = new Date().toISOString();
  const codes = Array.from({ length: count }, generateRecoveryCode);
  return { codes, hashes: codes.map((code) => ({ hash: hashRecoveryCode(code), usedAt: null, source, issuedAt })) };
}

/** Returns the index of the unused entry matching the code, or -1. Checks every entry (no early exit). */
export function matchRecoveryCode(entries, code) {
  const normalized = normalizeRecoveryCode(code);
  if (normalized.length !== 12) return -1;
  const hash = hashRecoveryCode(normalized);
  let found = -1;
  (entries ?? []).forEach((entry, index) => {
    if (safeEqualHex(String(entry?.hash ?? ''), hash) && !entry.usedAt && found < 0) found = index;
  });
  return found;
}

export const unusedRecoveryCount = (entries) => (entries ?? []).filter((entry) => !entry.usedAt).length;

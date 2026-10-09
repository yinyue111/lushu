// Location consent: the browser geolocation API is only called after the user has agreed
// in our own dialog (separate from the browser's permission prompt). Consent is stored on
// this device only, carries the policy version it was given for, and can be withdrawn.
export const LOCATION_CONSENT_KEY = 'trusted-routebook-location-consent';
export const LOCATION_POLICY_VERSION = '2026-10-draft-1';

function defaultStorage() {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** @param {any} [storage] */
export function readLocationConsent(storage = defaultStorage()) {
  try {
    const parsed = JSON.parse(storage?.getItem(LOCATION_CONSENT_KEY) ?? 'null');
    if (parsed?.granted === true && parsed.policyVersion === LOCATION_POLICY_VERSION) return parsed;
  } catch {
    // Corrupt value counts as no consent.
  }
  return null;
}

/** @param {any} [storage] */
export function hasLocationConsent(storage = defaultStorage()) {
  return Boolean(readLocationConsent(storage));
}

/** @param {any} [storage] @param {() => Date} [now] */
export function grantLocationConsent(storage = defaultStorage(), now = () => new Date()) {
  const record = { granted: true, policyVersion: LOCATION_POLICY_VERSION, grantedAt: now().toISOString() };
  try {
    storage?.setItem(LOCATION_CONSENT_KEY, JSON.stringify(record));
  } catch {
    // Storage unavailable: consent holds for this call only.
  }
  return record;
}

/** @param {any} [storage] */
export function withdrawLocationConsent(storage = defaultStorage()) {
  try {
    storage?.removeItem(LOCATION_CONSENT_KEY);
  } catch {
    // Nothing stored.
  }
}

/**
 * Calls geolocation only with consent. Returns 'needs-consent' without touching the API
 * otherwise, so the caller can show the consent dialog first.
 * @param {{ storage?: any, geolocation?: any, onPosition: (p: any) => void, onError: () => void, options?: any }} args
 */
export function requestPositionWithConsent({ storage = defaultStorage(), geolocation, onPosition, onError, options }) {
  if (!hasLocationConsent(storage)) return 'needs-consent';
  if (!geolocation) return 'unsupported';
  geolocation.getCurrentPosition(onPosition, onError, options);
  return 'requested';
}

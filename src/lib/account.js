// Bridges a signed-in account to the device: claims this device's drafts and switches the local
// profile to the account's profile (local data follows via adoptServerProfile).
import { getProfile, resetProfile } from './profile.js';
import { adoptServerProfile } from './profileSync.js';
import { getStoredRoutebooks } from './storage.js';
import { claimDeviceData } from './accountApi.js';

export const LOGIN_INTENT_KEY = 'trusted-routebook:login-intent:v1';

/** Drafts on this device that carry an edit token (the proof the server checks before moving them). */
export function deviceDraftsForClaim(profileId) {
  return getStoredRoutebooks(profileId)
    .map((book) => ({ id: String(book?.publicId || book?.id || ''), editToken: String(book?.editToken || '') }))
    .filter((item) => item.id && item.editToken)
    .slice(0, 200);
}

/** The device profile proof sent at registration/claim, when this device has a cloud profile. */
export function deviceProfileProof(profile = getProfile()) {
  return profile?.profileAccessToken && !profile?.accountUserId ? { id: profile.id, token: profile.profileAccessToken } : undefined;
}

/**
 * After login/registration: claim device data, then make the account's profile the local one.
 * @returns {Promise<{ profile: any, claim: any }>}
 */
export async function attachAccountToDevice(account, signal) {
  const before = getProfile();
  let claim = null;
  try {
    claim = await claimDeviceData({ deviceProfile: deviceProfileProof(before), drafts: deviceDraftsForClaim(before.id) }, signal);
  } catch (error) {
    claim = { error: error?.message || '草稿没能归入账号，稍后会再试' };
  }
  const sameProfile = before.id === account.profileId;
  if (!sameProfile) moveBuilderDraft(before.id, account.profileId);
  const { profile } = adoptServerProfile(
    {
      ...before,
      id: account.profileId,
      previousLocalId: sameProfile ? '' : before.id,
      accountUserId: account.id,
      accountPhoneMasked: account.phoneMasked || '',
      accountEmailMasked: account.emailMasked || '',
      cloudRegistrationConsentAt: before.cloudRegistrationConsentAt || new Date().toISOString(),
      // The device token only belongs to the device profile; the account profile is reached by cookie.
      profileAccessToken: sameProfile ? before.profileAccessToken : ''
    },
    before
  );
  return { profile, claim };
}

/** After logout: this device starts again as a fresh guest; the account's data stays in the cloud. */
export function detachAccountFromDevice() {
  return resetProfile();
}

export function claimSummary(claim) {
  if (!claim || claim.error) return claim?.error || '';
  const parts = [];
  if (claim.claimed) parts.push(`已把这台设备上的 ${claim.claimed} 份草稿放进你的账号`);
  if (claim.skipped) parts.push(`有 ${claim.skipped} 份草稿属于别的账号或已失效，没有移动`);
  if (claim.profileOwnedElsewhere) parts.push('这台设备之前的资料属于另一个账号，没有合并');
  return parts.join('；');
}

export function saveLoginIntent(intent) {
  try {
    sessionStorage.setItem(LOGIN_INTENT_KEY, JSON.stringify({ ...intent, at: Date.now() }));
  } catch {
    /* intent is a convenience only */
  }
}

/** Reads and clears a pending intent (valid for 30 minutes). */
export function takeLoginIntent() {
  try {
    const raw = sessionStorage.getItem(LOGIN_INTENT_KEY);
    sessionStorage.removeItem(LOGIN_INTENT_KEY);
    const intent = raw ? JSON.parse(raw) : null;
    return intent && Date.now() - Number(intent.at) < 30 * 60 * 1000 ? intent : null;
  } catch {
    return null;
  }
}

// The builder keeps an in-progress draft per profile id; carry it over so the user continues where they were.
const BUILDER_DRAFT_PREFIX = 'trusted-routebook:builder-draft:v1';
function moveBuilderDraft(fromId, toId) {
  try {
    const fromKey = `${BUILDER_DRAFT_PREFIX}:${encodeURIComponent(String(fromId || 'anonymous'))}`;
    const toKey = `${BUILDER_DRAFT_PREFIX}:${encodeURIComponent(String(toId))}`;
    const draft = localStorage.getItem(fromKey);
    if (!draft) return;
    const parsed = JSON.parse(draft);
    localStorage.setItem(toKey, JSON.stringify({ ...parsed, profileId: toId }));
    localStorage.removeItem(fromKey);
  } catch {
    /* best effort */
  }
}

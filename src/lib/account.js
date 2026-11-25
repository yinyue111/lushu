// Bridges a signed-in account to the device: claims this device's drafts and switches the local
// profile to the account's profile (local data follows via adoptServerProfile).
import { getProfile, resetProfile } from './profile.js';
import { clearLocalProfileData } from './profileData.js';
import { adoptServerProfile } from './profileSync.js';
import { getStoredRoutebooks } from './storage.js';
import { claimDeviceData, clearOfflineRoutebookData, logout as logoutRemote, logoutAll as logoutAllRemote } from './accountApi.js';

export const LOGIN_INTENT_KEY = 'trusted-routebook:login-intent:v1';
export const PENDING_LOGOUT_KEY = 'lushu:pending-logout:v1';
export const MAX_PENDING_LOGOUT_RETRIES = 3;
export const ACCOUNT_DETACHED_EVENT = 'lushu:account-detached';
export const OFFLINE_LOGOUT_TEXT = '网络不通，本机资料已清掉；联网后请再退出一次，才算彻底退出';

export function isLogoutSettledError(error) {
  return Number(error?.status) === 401;
}

export function readPendingLogout() {
  try {
    const raw = localStorage.getItem(PENDING_LOGOUT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const attempts = Number(parsed.attempts);
    return {
      everywhere: Boolean(parsed.everywhere),
      at: Number.isFinite(Number(parsed.at)) ? Number(parsed.at) : 0,
      attempts: Number.isFinite(attempts) && attempts >= 0 ? Math.floor(attempts) : 0
    };
  } catch {
    return null;
  }
}

export function savePendingLogout({ everywhere = false, attempts = 0 } = {}) {
  const existing = readPendingLogout();
  const normalizedAttempts = Number.isFinite(Number(attempts)) && Number(attempts) >= 0 ? Math.floor(Number(attempts)) : 0;
  const record = {
    everywhere: Boolean(everywhere || existing?.everywhere),
    at: Date.now(),
    attempts: normalizedAttempts
  };
  try {
    localStorage.setItem(PENDING_LOGOUT_KEY, JSON.stringify(record));
  } catch {
    /* best effort */
  }
  return record;
}

export function clearPendingLogout() {
  try {
    localStorage.removeItem(PENDING_LOGOUT_KEY);
  } catch {
    /* best effort */
  }
}

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
  // Logging in starts a fresh session; never let an earlier offline logout wipe it later.
  clearPendingLogout();
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

/** After logout: wipe local profile data on this device and start again as a fresh guest; cloud data stays in the account. */
export function detachAccountFromDevice(accountProfileId = '') {
  const currentId = getProfile()?.id || '';
  const ids = new Set([String(accountProfileId || '').trim(), String(currentId).trim()].filter(Boolean));
  for (const id of ids) {
    try {
      clearLocalProfileData(id);
    } catch {
      /* best effort */
    }
    try {
      localStorage.removeItem(`${BUILDER_DRAFT_PREFIX}:${encodeURIComponent(id)}`);
    } catch {
      /* best effort */
    }
  }
  const fresh = resetProfile();
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent(ACCOUNT_DETACHED_EVENT, { detail: { profile: fresh } }));
  }
  return fresh;
}

/**
 * Runs a user-initiated logout: always clears local data + offline SW cache, and only marks
 * the session signed-out when the server confirms (200) or reports 401.
 * @param {{ everywhere?: boolean, accountProfileId?: string, remoteLogout?: () => Promise<any> }} [options]
 */
export async function executeLogout({ everywhere = false, accountProfileId = '', remoteLogout } = {}) {
  const send = remoteLogout ?? (() => (everywhere ? logoutAllRemote() : logoutRemote()));
  let settled = false;
  try {
    await send();
    settled = true;
  } catch (error) {
    if (isLogoutSettledError(error)) {
      settled = true;
    } else {
      savePendingLogout({ everywhere });
    }
  } finally {
    await clearOfflineRoutebookData();
  }
  const profile = detachAccountFromDevice(accountProfileId);
  if (settled) {
    clearPendingLogout();
    return {
      settled: true,
      everywhere: Boolean(everywhere),
      profile,
      toast: everywhere ? '已在所有设备上退出登录' : '已退出登录'
    };
  }
  return {
    settled: false,
    everywhere: Boolean(everywhere),
    profile,
    toast: OFFLINE_LOGOUT_TEXT
  };
}

/**
 * Retries a queued pending logout (on reconnect or next startup).
 * Keeps the marker when the server fails with network/5xx; clears it on 200 or 401.
 * @param {{ accountProfileId?: string, remoteLogout?: (everywhere: boolean) => Promise<any>, isCancelled?: () => boolean }} [options]
 */
export async function retryPendingLogout({ accountProfileId = '', remoteLogout, isCancelled } = {}) {
  const pending = readPendingLogout();
  if (!pending) return { settled: false, pending: false, everywhere: false, profile: null, toast: '' };
  const send = remoteLogout ?? ((everywhere) => (everywhere ? logoutAllRemote() : logoutRemote()));
  let settled = false;
  try {
    await send(pending.everywhere);
    settled = true;
  } catch (error) {
    if (isLogoutSettledError(error)) settled = true;
  }
  if (isCancelled?.() || !readPendingLogout()) {
    return { settled: false, pending: false, everywhere: pending.everywhere, profile: null, toast: '' };
  }
  if (!settled) {
    const nextAttempts = (pending.attempts || 0) + 1;
    if (nextAttempts >= MAX_PENDING_LOGOUT_RETRIES) {
      clearPendingLogout();
      return { settled: false, pending: false, dropped: true, attempts: nextAttempts, everywhere: pending.everywhere, profile: null, toast: '' };
    }
    savePendingLogout({ everywhere: pending.everywhere, attempts: nextAttempts });
    return { settled: false, pending: true, attempts: nextAttempts, everywhere: pending.everywhere, profile: null, toast: '' };
  }
  clearPendingLogout();
  await clearOfflineRoutebookData();
  const profile = detachAccountFromDevice(accountProfileId);
  return {
    settled: true,
    pending: false,
    everywhere: pending.everywhere,
    profile,
    toast: pending.everywhere ? '已在所有设备上退出登录' : '已退出登录'
  };
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

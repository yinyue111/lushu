import { deleteJson, getJson, ownerHeaders, postJson } from './api.js';

export function issueRecoveryCode(profileId, signal) {
  return postJson('/profile/recovery-code', { profileId }, signal, ownerHeaders(profileId));
}

export function exportProfileData(profileId, signal) {
  return getJson(`/profile/export?profileId=${encodeURIComponent(profileId)}`, signal, ownerHeaders(profileId));
}

export function logoutProfileRemote(profileId, signal) {
  return postJson('/profile/logout', { profileId }, signal, ownerHeaders(profileId));
}

export function deleteProfileRemote(profileId, confirmation, signal) {
  return deleteJson('/profile', { profileId, confirmation }, signal, ownerHeaders(profileId));
}

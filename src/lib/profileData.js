import { deleteRoutebook, getStoredRoutebooks } from './storage.js';

const ROOT = 'trusted-routebook:';

export function stripLocalExportSecrets(value) {
  if (Array.isArray(value)) return value.map(stripLocalExportSecrets);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !['profileAccessToken', 'editToken', 'accessTokenHash', 'editTokenHash', 'pendingRegistrationSecret'].includes(key))
      .map(([key, child]) => [key, stripLocalExportSecrets(child)])
  );
}

export function clearLocalProfileData(profileId) {
  for (const routebook of getStoredRoutebooks(profileId)) deleteRoutebook(routebook);
  const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
  for (const key of keys) {
    if (!key?.startsWith(ROOT) || key === `${ROOT}profile:v1`) continue;
    if (
      key.startsWith(`${ROOT}checkins:${profileId}:`) ||
      key.startsWith(`${ROOT}trip-session:v1:${encodeURIComponent(profileId)}:`) ||
      key === `${ROOT}clicks:${profileId}` ||
      key === `${ROOT}favorites:${profileId}`
    ) {
      localStorage.removeItem(key);
      continue;
    }
    let value;
    try {
      value = JSON.parse(localStorage.getItem(key));
    } catch {
      continue;
    }
    if (Array.isArray(value)) {
      const retained = value.filter((row) => row?.profileId !== profileId);
      if (retained.length !== value.length) localStorage.setItem(key, JSON.stringify(retained));
    } else if (value?.profileId === profileId || value?.localProfileId === profileId) localStorage.removeItem(key);
  }
}

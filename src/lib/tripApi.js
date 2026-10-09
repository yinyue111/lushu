import { getJson, ownerHeaders, postJson } from './api.js';

export function getTripSessionRemote(routeId, profileId, signal) {
  return getJson(`/trip-sessions/${encodeURIComponent(routeId)}?profileId=${encodeURIComponent(profileId)}`, signal, ownerHeaders(profileId));
}

export function saveTripSessionRemote(routeId, profileId, session, signal) {
  return postJson(`/trip-sessions/${encodeURIComponent(routeId)}`, { ...session, profileId }, signal, ownerHeaders(profileId));
}

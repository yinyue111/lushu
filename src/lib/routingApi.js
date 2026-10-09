import { adminHeaders, postJson } from './api.js';

export function recheckRoutebookRouting(publicId, expectedVersion, signal) {
  return postJson(`/routebooks/${encodeURIComponent(publicId)}/routing`, { expectedVersion }, signal, adminHeaders());
}

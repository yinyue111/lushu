import { adminHeaders, getJson, postJson } from './api.js';

export function getOpsCheckins(limit = 100, signal, { filter = 'all', cursor = '' } = {}) {
  const params = new URLSearchParams({ limit: String(limit), filter });
  if (cursor) params.set('cursor', cursor);
  return getJson(`/ops/checkins?${params.toString()}`, signal, adminHeaders());
}

export function getOpsImports(limit = 100, signal) {
  return getJson(`/ops/imports?limit=${limit}`, signal, adminHeaders());
}

export function saveOpsDisposition(entityType, entityId, payload, signal) {
  const resource = entityType === 'checkin' ? 'checkins' : 'import-sources';
  return postJson(`/ops/${resource}/${encodeURIComponent(entityId)}/audits`, payload, signal, adminHeaders());
}

export function getOpsPoiDuplicates(city = '', signal) {
  const params = new URLSearchParams({ limit: '100' });
  if (city) params.set('city', city);
  return getJson(`/ops/poi-duplicates?${params.toString()}`, signal, adminHeaders());
}

export function saveOpsPoiMergeDecision(payload, signal) {
  return postJson('/ops/poi-merges', payload, signal, adminHeaders());
}

export function getOpsModeration(status = 'open', signal) {
  return getJson(`/ops/moderation?status=${encodeURIComponent(status)}&limit=100`, signal, adminHeaders());
}

export function saveOpsModerationDecision(entityType, entityId, payload, signal) {
  return postJson(`/ops/moderation/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}`, payload, signal, adminHeaders());
}

export function getOpsUsers(query = '', signal) {
  const params = new URLSearchParams({ limit: '100' });
  if (query) params.set('q', query);
  return getJson(`/ops/users?${params.toString()}`, signal, adminHeaders());
}

export function saveOpsUserAction(userId, payload, signal) {
  return postJson(`/ops/users/${encodeURIComponent(userId)}`, payload, signal, adminHeaders());
}

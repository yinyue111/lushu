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

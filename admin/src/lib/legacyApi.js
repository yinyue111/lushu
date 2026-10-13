// Legacy ops API used by the in-console "旧运维工具" panels. The script token (X-Routebook-Admin-Token)
// is held in memory only for the current tab: never written to localStorage/sessionStorage, gone on reload.
// None of this ships in the user bundle (scripts/check-bundle-leaks.mjs enforces it).
import { getJson, postJson } from '../../../src/lib/api.js';

export * from '../../../src/lib/api.js';

let scriptToken = '';

export function adminHeaders() {
  return scriptToken ? { 'x-routebook-admin-token': scriptToken } : {};
}

export function getAdminToken() {
  return scriptToken;
}

export function setAdminToken(token) {
  scriptToken = String(token ?? '').trim();
  return scriptToken;
}

export async function getRoutebooks(limit = 100, signal, cursor = '') {
  return getJson(`/routebooks?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, signal, adminHeaders());
}

export async function updateRoutebookStatus(publicId, payload, signal) {
  return postJson(`/routebooks/${encodeURIComponent(publicId)}/status`, payload, signal, adminHeaders());
}

export async function getDashboard(limit = 1000, signal) {
  return getJson(`/dashboard?limit=${limit}`, signal, adminHeaders());
}

export async function getPoiCorrections(limit = 80, signal) {
  return getJson(`/poi-corrections?limit=${limit}`, signal, adminHeaders());
}

export async function updatePoiCorrectionStatus(id, action, reviewerNote = '', signal) {
  return postJson(`/poi-corrections/${encodeURIComponent(id)}/status`, { action, reviewerNote }, signal, adminHeaders());
}

export async function getPoiCoverage(signal) {
  return getJson('/poi-coverage', signal, adminHeaders());
}

export async function getPois({ city = '', reviewStatus = '', freshnessState = '', limit = 200 } = {}, signal) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (city) params.set('city', city);
  if (reviewStatus) params.set('reviewStatus', reviewStatus);
  if (freshnessState) params.set('freshnessState', freshnessState);
  return getJson(`/pois?${params.toString()}`, signal, adminHeaders());
}

export async function validatePois(content, signal) {
  return postJson('/pois/validate', { content }, signal, adminHeaders());
}

/**
 * @param {{ content?: string, batchId?: string, commitToken?: string, rows?: any[] }} [input]
 * @param {AbortSignal} [signal]
 */
export async function upsertPois({ content = '', batchId = '', commitToken = '', rows } = {}, signal) {
  const body = { content, batchId, commitToken };
  if (Array.isArray(rows)) body.rows = rows;
  return postJson('/pois/upsert', body, signal, adminHeaders());
}

export async function getRoutebookVersions(publicId, signal) {
  return getJson(`/routebooks/${encodeURIComponent(publicId)}/versions`, signal, adminHeaders());
}

export async function getImports(limit = 50, signal) {
  return getJson(`/imports?limit=${limit}`, signal, adminHeaders());
}

export async function saveCmsConfig(config, signal) {
  return postJson('/cms', config, signal, adminHeaders());
}

export async function saveProducts(products, signal) {
  return postJson('/products', { products }, signal, adminHeaders());
}

export async function getLogs(limit = 50, signal) {
  return getJson(`/logs?limit=${limit}`, signal, adminHeaders());
}

export async function getCheckins(limit = 50, signal) {
  return getJson(`/checkins?limit=${limit}`, signal, adminHeaders());
}

export async function getProductAnalytics(limit = 500, signal) {
  return getJson(`/product-analytics?limit=${limit}`, signal, adminHeaders());
}

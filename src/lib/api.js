import { getProfile, prepareProfileSyncPayload } from './profile.js';

const API_BASE = import.meta.env?.VITE_API_BASE_URL ?? '/api';
const ADMIN_TOKEN_KEY = 'trusted-routebook:admin-token';
const PUBLIC_TOKEN_KEY = 'trusted-routebook:api-token';

async function readApiResponse(response) {
  const parsed = await response.json().catch(() => ({}));
  const data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  const requestId = data.requestId || response.headers.get('x-request-id') || '';
  if (requestId && !data.requestId) data.requestId = requestId;
  if (!response.ok) {
    const error = /** @type {Error & Record<string, any>} */ (new Error(data.error ?? `HTTP ${response.status}`));
    error.status = response.status;
    error.code = data.code;
    error.requestId = requestId;
    // Lets the account layer offer the login sheet wherever a gated action was refused.
    if (data.code === 'LOGIN_REQUIRED' && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('lushu:login-required'));
    // A routebook deleted from the account (maybe on another device): let the app drop the local copy.
    if (data.code === 'ROUTEBOOK_DELETED' && typeof window !== 'undefined' && data.details?.id) {
      window.dispatchEvent(new CustomEvent('lushu:routebook-deleted', { detail: { id: String(data.details.id) } }));
    }
    if (data.details && typeof data.details === 'object') error.details = data.details;
    if (Number.isInteger(Number(data.currentVersion)) && Number(data.currentVersion) >= 0) {
      error.currentVersion = Number(data.currentVersion);
    }
    throw error;
  }
  return data;
}

export async function postJson(path, body, signal, extraHeaders = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...publicHeaders(), ...extraHeaders },
    body: JSON.stringify(body),
    signal
  });
  return readApiResponse(response);
}

export async function getJson(path, signal, extraHeaders = {}) {
  const response = await fetch(`${API_BASE}${path}`, { signal, headers: { ...publicHeaders(), ...extraHeaders } });
  return readApiResponse(response);
}

export async function deleteJson(path, body, signal, extraHeaders = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', ...publicHeaders(), ...extraHeaders },
    body: JSON.stringify(body),
    signal
  });
  return readApiResponse(response);
}

export async function checkHealth(signal) {
  // L5: production only returns provider/model details to operators.
  return getJson('/health', signal, adminHeaders());
}

/** Synchronous generation (legacy; holds the request for the whole model call). */
export async function generateRoutebook(input, signal) {
  return postJson('/generate-routebook', generationRequestBody(input), signal, ownerHeaders(input?.profileId));
}

function generationRequestBody({ city, guide, constraints, importedSources, profileId, editToken, guideOrigins, mode }) {
  return {
    city,
    ...(mode ? { mode } : {}),
    guide,
    profileId,
    editToken,
    importedSources,
    constraints,
    ...(Array.isArray(guideOrigins) && guideOrigins.length ? { guideOrigins } : {}),
    client: {
      locale: 'zh-CN',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
    }
  };
}

/** Starts an async generation job; resolves with { job, deduplicated } right away. */
export async function startGenerationJob(input, signal) {
  return postJson('/generation-jobs', generationRequestBody(input), signal, ownerHeaders(input?.profileId));
}

/**
 * Long-polls a job: the server answers when `seq` changes or after ~15 s.
 * @param {string} jobId
 * @param {{ after?: number, profileId?: string }} [options]
 * @param {AbortSignal} [signal]
 */
export async function getGenerationJob(jobId, { after, profileId } = {}, signal) {
  const query = Number.isInteger(after) && after >= 0 ? `?after=${after}` : '';
  return getJson(`/generation-jobs/${encodeURIComponent(jobId)}${query}`, signal, ownerHeaders(profileId));
}

export async function cancelGenerationJob(jobId, profileId, signal) {
  return postJson(`/generation-jobs/${encodeURIComponent(jobId)}/cancel`, {}, signal, ownerHeaders(profileId));
}

export async function importGuide(urls, signal) {
  return postJson('/import-guide', { urls }, signal);
}

export async function analyzeGuideImages(images, signal) {
  return postJson('/ocr-guide', { images }, signal);
}

export async function saveRoutebookRemote(routebook, optionsOrSignal, maybeSignal) {
  const options = optionsOrSignal && typeof optionsOrSignal === 'object' && !('aborted' in optionsOrSignal) ? optionsOrSignal : {};
  const signal = maybeSignal ?? (optionsOrSignal && 'aborted' in optionsOrSignal ? optionsOrSignal : undefined);
  const body = { ...routebook, ...options };
  if (!hasExpectedVersion(body)) {
    const currentVersion = routebookVersion(routebook);
    if (currentVersion != null) body.expectedVersion = currentVersion;
  }
  return postJson('/routebooks', body, signal, ownerHeaders(body.profileId));
}

export async function saveRoutebookVariant(publicId, payload, signal) {
  const body =
    payload && typeof payload === 'object' && ('variant' in payload || 'editToken' in payload || 'profileId' in payload) ? payload : { variant: payload };
  return postJson(`/routebooks/${encodeURIComponent(publicId)}/variants`, body, signal, ownerHeaders(body.profileId));
}

/**
 * @param {string} publicId
 * @param {AbortSignal} [signal]
 * @param {{ editToken?: string }} [options] guests (no cloud profile) prove ownership with the draft's edit token
 */
export async function getRoutebookRemote(publicId, signal, { editToken = '' } = {}) {
  const profile = getProfile();
  const token = String(editToken ?? '').trim();
  const headers = { ...ownerHeaders(profile.id), ...(/^[\w-]{16,96}$/.test(token) ? { 'x-routebook-edit-token': token } : {}) };
  return getJson(`/routebooks/${encodeURIComponent(publicId)}`, signal, headers);
}

/** Background-checked 门票 / 开放时间 for a saved routebook (same read access as the routebook). */
export async function getRoutebookEnrichment(publicId, signal, { editToken = '' } = {}) {
  const profile = getProfile();
  const token = String(editToken ?? '').trim();
  const headers = { ...ownerHeaders(profile.id), ...(/^[\w-]{16,96}$/.test(token) ? { 'x-routebook-edit-token': token } : {}) };
  return getJson(`/routebooks/${encodeURIComponent(publicId)}/enrichment`, signal, headers);
}

/** "This is wrong" for one enriched value. */
export async function reportRoutebookEnrichment(publicId, { stopKey, field, note = '', editToken = '' }, signal) {
  const profile = getProfile();
  const token = String(editToken ?? '').trim();
  const headers = { ...ownerHeaders(profile.id), ...(/^[\w-]{16,96}$/.test(token) ? { 'x-routebook-edit-token': token } : {}) };
  return postJson(`/routebooks/${encodeURIComponent(publicId)}/enrichment/report`, { stopKey, field, note }, signal, headers);
}

/**
 * @param {string} publicId
 * @param {AbortSignal} [signal]
 * @param {string} [friendKey] unlisted friend-link key (`?k=`)
 */
export async function getShareRoutebook(publicId, signal, friendKey = '') {
  const key = /^[a-f0-9]{32}$/.test(String(friendKey)) ? `?k=${friendKey}` : '';
  return getJson(`/share/${encodeURIComponent(publicId)}${key}`, signal);
}

/** Owner re-geocodes replaced stops and re-verifies touched road legs (drafts, rate-limited). */
export async function recheckOwnRoutebook(publicId, payload = {}, signal) {
  return postJson(`/routebooks/${encodeURIComponent(publicId)}/recheck`, payload, signal, ownerHeaders(payload?.profileId));
}

/** Owner creates (or keeps) the unlisted friend link; the server generates the key. */
export async function createFriendLink(publicId, payload = {}, signal) {
  return postJson(`/routebooks/${encodeURIComponent(publicId)}/friend-link`, payload, signal, ownerHeaders(payload?.profileId));
}

export async function revokeFriendLink(publicId, payload = {}, signal) {
  return deleteJson(`/routebooks/${encodeURIComponent(publicId)}/friend-link`, payload, signal, ownerHeaders(payload?.profileId));
}

export async function getRoutebooks(limit = 100, signal, cursor = '') {
  return getJson(`/routebooks?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, signal, adminHeaders());
}

/** Which of these routebook ids were deleted (so local copies can be dropped). */
export async function checkDeletedRoutebooks(ids, signal) {
  return postJson('/routebooks/deleted', { ids }, signal);
}

/** Deletes the cloud copy of the caller's own routebook (signed-in owner, profile token or edit token). */
export async function deleteRoutebookRemote(publicId, { profileId = '', editToken = '' } = {}, signal) {
  return deleteJson(`/routebooks/${encodeURIComponent(publicId)}`, {}, signal, {
    ...ownerHeaders(profileId),
    ...(editToken ? { 'x-routebook-edit-token': editToken } : {})
  });
}

export async function getMyRoutebooks(profileId, limit = 100, signal) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (profileId) params.set('profileId', profileId);
  return getJson(`/routebooks?${params.toString()}`, signal, ownerHeaders(profileId));
}

export async function getRoutebooksByCity(city, limit = 100, signal) {
  return getJson(`/routebooks?city=${encodeURIComponent(city)}&status=published,featured&limit=${limit}`, signal);
}

export async function updateRoutebookStatus(publicId, payload, signal) {
  return postJson(`/routebooks/${encodeURIComponent(publicId)}/status`, payload, signal, adminHeaders());
}

export async function publishOwnRoutebook(publicId, payload = {}, signal) {
  return postJson(`/routebooks/${encodeURIComponent(publicId)}/publish`, payload, signal, ownerHeaders(payload?.profileId));
}

function routebookVersion(routebook) {
  const value = routebook?.version ?? routebook?.currentVersion ?? routebook?.revision;
  const version = Number(value);
  return Number.isInteger(version) && version >= 0 ? version : null;
}

function hasExpectedVersion(payload) {
  return Object.prototype.hasOwnProperty.call(payload ?? {}, 'expectedVersion') && payload.expectedVersion !== '' && payload.expectedVersion != null;
}

export async function copyRoutebookRemote(publicId, payload = {}, signal) {
  return postJson(`/routebooks/${encodeURIComponent(publicId)}/copy`, payload, signal, ownerHeaders(payload?.profileId));
}

export async function getCreatorProfile(creatorId, signal) {
  return getJson(`/creators/${encodeURIComponent(creatorId)}`, signal);
}

export async function getDashboard(limit = 1000, signal) {
  return getJson(`/dashboard?limit=${limit}`, signal, adminHeaders());
}

export async function getCities(query = '', signal) {
  return getJson(`/cities?q=${encodeURIComponent(query)}`, signal);
}

export async function createPoiCorrection(correction, signal) {
  return postJson('/poi-corrections', correction, signal);
}

export async function getPoiCorrections(limit = 80, signal) {
  return getJson(`/poi-corrections?limit=${limit}`, signal, adminHeaders());
}

export async function updatePoiCorrectionStatus(id, action, reviewerNote = '', signal) {
  return postJson(`/poi-corrections/${encodeURIComponent(id)}/status`, { action, reviewerNote }, signal, adminHeaders());
}

export async function getPoiKnowledge({ city = '', stopName = '', limit = 20 } = {}, signal) {
  const params = new URLSearchParams();
  if (city) params.set('city', city);
  if (stopName) params.set('stopName', stopName);
  params.set('limit', String(limit));
  return getJson(`/poi-knowledge?${params.toString()}`, signal);
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

export async function createFavorite(favorite, signal) {
  return postJson('/favorites', favorite, signal, ownerHeaders(favorite?.profileId));
}

export async function deleteFavorite(profileId, routeId, signal) {
  return deleteJson('/favorites', { profileId, routeId }, signal, ownerHeaders(profileId));
}

export async function getMyFavorites(profileId, limit = 80, signal) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (profileId) params.set('profileId', profileId);
  return getJson(`/favorites?${params.toString()}`, signal, ownerHeaders(profileId));
}

export async function getImports(limit = 50, signal) {
  return getJson(`/imports?limit=${limit}`, signal, adminHeaders());
}

export async function createReviewShare(review, signal) {
  return postJson('/reviews', review, signal, ownerHeaders(review?.profileId));
}

export async function getReviewShare(publicId, signal) {
  return getJson(`/reviews/${encodeURIComponent(publicId)}`, signal);
}

export async function getCmsConfig(signal) {
  return getJson('/cms', signal);
}

export async function saveCmsConfig(config, signal) {
  return postJson('/cms', config, signal, adminHeaders());
}

export async function getProducts(signal) {
  return getJson('/products', signal);
}

export async function saveProducts(products, signal) {
  return postJson('/products', { products }, signal, adminHeaders());
}

export async function saveProfile(profile, signal) {
  return postJson('/profile', prepareProfileSyncPayload(profile), signal, ownerHeaders(profile?.id));
}

export async function createCheckin(checkin, signal) {
  return postJson('/checkins', checkin, signal, ownerHeaders(checkin?.profileId));
}

// 打卡照片证据上传。photo: { profileId, routeId, stopId, imageBase64, mimeType }。
// imageBase64 支持 dataURL 或裸 base64；服务端限制大小与类型并返回 { photo: { id, url } }。
export async function uploadCheckinPhoto(photo, signal) {
  return postJson('/checkin-photos', photo, signal, ownerHeaders(photo?.profileId));
}

export function checkinPhotoUrl(photoId) {
  const id = String(photoId ?? '').trim();
  return id ? `${API_BASE}/checkin-photos/${encodeURIComponent(id)}` : '';
}

export async function recordClick(click, signal) {
  return postJson('/clicks', click, signal, ownerHeaders(click?.profileId));
}

export async function recordExposure(exposure, signal) {
  return postJson('/exposures', exposure, signal, ownerHeaders(exposure?.profileId));
}

export async function recordJourneyEvent(surface, routebook, profileId, signal) {
  const routeId = routebook?.publicId || routebook?.id;
  if (!routeId || !profileId) return null;
  const travelDate = [routebook?.travelDate, routebook?.constraints?.date, routebook?.provider?.travelDate].map(normalizeJourneyTravelDate).find(Boolean) || '';
  return recordExposure(
    {
      profileId,
      surface,
      itemType: 'journey-event',
      itemId: routeId,
      routeId,
      routeTitle: routebook?.title,
      city: routebook?.city,
      creatorId: routebook?.creator?.id,
      travelDate
    },
    signal
  );
}

function normalizeJourneyTravelDate(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return '';
  const timestamp = Date.parse(`${text}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp)) return '';
  return new Date(timestamp).toISOString().slice(0, 10) === text ? text : '';
}

export async function getLogs(limit = 50, signal) {
  return getJson(`/logs?limit=${limit}`, signal, adminHeaders());
}

export async function getCheckins(limit = 50, signal) {
  return getJson(`/checkins?limit=${limit}`, signal, adminHeaders());
}

export async function getMyCheckins(profileId, limit = 50, signal) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (profileId) params.set('profileId', profileId);
  return getJson(`/checkins?${params.toString()}`, signal, ownerHeaders(profileId));
}

export async function getMyClicks(profileId, limit = 50, signal) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (profileId) params.set('profileId', profileId);
  return getJson(`/clicks?${params.toString()}`, signal, ownerHeaders(profileId));
}

export async function getProductAnalytics(limit = 500, signal) {
  return getJson(`/product-analytics?limit=${limit}`, signal, adminHeaders());
}

export function adminHeaders() {
  const ADMIN_TOKEN = typeof sessionStorage === 'undefined' ? '' : (sessionStorage.getItem(ADMIN_TOKEN_KEY) ?? '');
  return ADMIN_TOKEN ? { 'x-routebook-admin-token': ADMIN_TOKEN } : {};
}

export function ownerHeaders(profileId) {
  const admin = adminHeaders();
  try {
    const profile = getProfile();
    if (profile?.id === profileId && profile?.profileAccessToken) {
      return {
        ...admin,
        'x-routebook-profile-id': profile.id,
        'x-routebook-profile-token': profile.profileAccessToken
      };
    }
  } catch {
    // Fall back to admin/public headers when profile storage is unavailable.
  }
  return admin;
}

export function getAdminToken() {
  return typeof sessionStorage === 'undefined' ? '' : (sessionStorage.getItem(ADMIN_TOKEN_KEY) ?? '');
}

export function setAdminToken(token) {
  if (typeof sessionStorage === 'undefined') return '';
  const next = String(token ?? '').trim();
  if (next) sessionStorage.setItem(ADMIN_TOKEN_KEY, next);
  else sessionStorage.removeItem(ADMIN_TOKEN_KEY);
  return next;
}

export function getApiToken() {
  return typeof sessionStorage === 'undefined' ? '' : (sessionStorage.getItem(PUBLIC_TOKEN_KEY) ?? '');
}

export function setApiToken(token) {
  if (typeof sessionStorage === 'undefined') return '';
  const next = String(token ?? '').trim();
  if (next) sessionStorage.setItem(PUBLIC_TOKEN_KEY, next);
  else sessionStorage.removeItem(PUBLIC_TOKEN_KEY);
  return next;
}

function publicHeaders() {
  const token = getApiToken();
  return token ? { 'x-routebook-token': token } : {};
}

export async function searchPois(city, q, signal) {
  const params = new URLSearchParams({ city: String(city || ''), q: String(q || '') });
  return getJson(`/pois/search?${params}`, signal);
}

export async function proposeRoutebookPatch(publicId, payload, signal) {
  const body = { ...payload };
  return postJson(`/routebooks/${encodeURIComponent(publicId)}/patch/propose`, body, signal, ownerHeaders(body.profileId));
}

export async function applyRoutebookPatch(publicId, payload, signal) {
  const body = { ...payload };
  return postJson(`/routebooks/${encodeURIComponent(publicId)}/patch/apply`, body, signal, ownerHeaders(body.profileId));
}

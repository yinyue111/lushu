const PROFILE_KEY = 'trusted-routebook:profile:v1';
const PROFILE_SYNC_PREFIX = 'trb1_';
const PROFILE_REGISTRATION_KEY = 'trusted-routebook:profile-registration:v1';

const defaultProfile = {
  homeCity: '杭州',
  preferredCities: ['杭州', '上海', '苏州'],
  budget: '',
  companion: '朋友',
  tempo: '松弛但不空',
  transport: '步行 + 打车',
  themes: ['Citywalk'],
  creatorName: '',
  creatorBio: '',
  cloudRegistrationConsentAt: ''
};

export function getProfile() {
  const stored = readProfile();
  const id = stored.id || createProfileId();
  const profile = { ...defaultProfile, ...stored, id };
  if (!stored.id) writeProfile(profile);
  return profile;
}

export function updateProfile(patch) {
  const current = getProfile();
  const next = {
    ...current,
    ...patch,
    preferredCities: normalizeList(patch.preferredCities ?? current.preferredCities).slice(0, 12),
    themes: normalizeList(patch.themes ?? current.themes).slice(0, 12),
    updatedAt: new Date().toISOString()
  };
  writeProfile(next);
  return next;
}

export function replaceProfile(nextProfile) {
  const current = getProfile();
  const next = {
    ...current,
    ...nextProfile,
    preferredCities: normalizeList(nextProfile.preferredCities ?? current.preferredCities).slice(0, 12),
    themes: normalizeList(nextProfile.themes ?? current.themes).slice(0, 12),
    updatedAt: new Date().toISOString()
  };
  if (!writeProfile(next)) throw new Error('无法保存本机账号凭据，请检查浏览器存储空间');
  return next;
}

export function grantProfileCloudRegistrationConsent(profile = getProfile()) {
  return replaceProfile({ ...profile, cloudRegistrationConsentAt: new Date().toISOString() });
}

/** Whether this device can talk to the cloud as its profile: a device token, or a signed-in account (cookie). */
export function canSyncToCloud(profile = getProfile()) {
  return Boolean(profile?.profileAccessToken || profile?.accountUserId);
}

export function hasProfileCloudRegistrationConsent(profile = getProfile()) {
  return (
    Boolean(profile?.accountUserId) || Boolean(profile?.profileAccessToken) || Number.isFinite(Date.parse(String(profile?.cloudRegistrationConsentAt ?? '')))
  );
}

// Persist the random registration credential before the first request. Lost
// responses can then retry without creating a second cloud account.
export function prepareProfileSyncPayload(profile = getProfile()) {
  // Signed-in accounts own their server profile through the login cookie; no device registration.
  if (profile?.accountUserId || profile?.profileAccessToken || profile?.recoveryProof || profile?.identity?.proof) return profile;
  if (!hasProfileCloudRegistrationConsent(profile)) {
    const error = Object.assign(new Error('尚未同意云端同步；偏好和行程继续保留在本机'), { code: 'PROFILE_CLOUD_REGISTRATION_CONSENT_REQUIRED' });
    throw error;
  }
  let pending;
  try {
    pending = JSON.parse(safeGetItem(PROFILE_REGISTRATION_KEY) || 'null');
  } catch {
    pending = null;
  }
  if (pending?.localProfileId !== profile.id || !/^preg_[A-Za-z0-9_-]{43}$/.test(pending?.secret || '')) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const secret = `preg_${btoa(String.fromCharCode(...bytes))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '')}`;
    pending = { localProfileId: profile.id, secret };
    if (!safeSetItem(PROFILE_REGISTRATION_KEY, JSON.stringify(pending))) throw new Error('无法保存注册凭据，未发送同步请求');
  }
  return { ...profile, pendingRegistrationSecret: pending.secret };
}

export function resetProfile() {
  const fresh = { ...defaultProfile, id: createProfileId(), preferredCities: [...defaultProfile.preferredCities], themes: [...defaultProfile.themes] };
  if (!writeProfile(fresh)) throw new Error('无法清除本机账号凭据，请在浏览器设置中清除本站数据');
  try {
    localStorage.removeItem(PROFILE_REGISTRATION_KEY);
  } catch {
    /* New profile does not reuse this record. */
  }
  return fresh;
}

export function profileRoutebookFields(profile = getProfile()) {
  return {
    profileId: profile.id,
    creator: {
      id: profile.id,
      name: profile.creatorName || '匿名旅行者',
      bio: profile.creatorBio || `${profile.homeCity || '本地'}出发，偏好${profile.tempo || '松弛'}路线`,
      sourceAuthorization: 'user-generated'
    }
  };
}

export function createRouteEditToken() {
  if (crypto?.randomUUID) return `rt_${crypto.randomUUID().replace(/-/g, '')}${Date.now().toString(36)}`;
  return `rt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 18)}`;
}

export function parseProfileSyncCode(value) {
  const code = String(value ?? '').trim();
  if (!code.startsWith(PROFILE_SYNC_PREFIX)) {
    throw new Error('恢复码格式不正确');
  }
  try {
    const payload = JSON.parse(decodeBase64Url(code.slice(PROFILE_SYNC_PREFIX.length)));
    const profileId = String(payload?.profileId ?? '').trim();
    if (payload?.version === 2 && isValidProfileId(profileId) && /^[A-Za-z0-9_-]{16,80}$/.test(payload.nonce) && /^[a-f0-9]{64}$/.test(payload.proof)) {
      if (!Number.isFinite(Date.parse(payload.expiresAt)) || Date.parse(payload.expiresAt) <= Date.now()) throw new Error('expired');
      return { profileId, recoveryNonce: payload.nonce, recoveryExpiresAt: payload.expiresAt, recoveryProof: payload.proof };
    }
    const profileAccessToken = String(payload?.profileAccessToken ?? '').trim();
    if (payload?.version !== 1 || !isValidProfileId(profileId) || !isValidProfileToken(profileAccessToken)) {
      throw new Error('invalid payload');
    }
    return { profileId, profileAccessToken };
  } catch {
    throw new Error('恢复码无效或已损坏');
  }
}

function readProfile() {
  try {
    const data = JSON.parse(safeGetItem(PROFILE_KEY) ?? '{}');
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function writeProfile(profile) {
  return safeSetItem(PROFILE_KEY, JSON.stringify(profile));
}

function createProfileId() {
  if (crypto?.randomUUID) return `p_${crypto.randomUUID().replace(/-/g, '').slice(0, 18)}`;
  return `p_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item ?? '').trim()).filter(Boolean);
  return String(value ?? '')
    .split(/[、,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function isValidProfileId(value) {
  return /^[A-Za-z0-9_-]{3,80}$/.test(value) && value !== 'anonymous';
}

function isValidProfileToken(value) {
  return /^[A-Za-z0-9_-]{16,96}$/.test(value);
}

function decodeBase64Url(value) {
  const normalized = String(value ?? '')
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function safeGetItem(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetItem(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

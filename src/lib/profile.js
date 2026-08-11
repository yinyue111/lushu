const PROFILE_KEY = 'trusted-routebook:profile:v1';
const PROFILE_SYNC_PREFIX = 'trb1_';

const defaultProfile = {
  homeCity: '杭州',
  preferredCities: ['杭州', '上海', '苏州'],
  budget: '人均 900',
  companion: '朋友',
  tempo: '松弛但不空',
  transport: '步行 + 打车',
  themes: ['Citywalk'],
  creatorName: '',
  creatorBio: ''
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
  writeProfile(next);
  return next;
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

export function createProfileSyncCode(profile = getProfile()) {
  const profileId = String(profile?.id ?? '').trim();
  const profileAccessToken = String(profile?.profileAccessToken ?? '').trim();
  if (!isValidProfileId(profileId) || !isValidProfileToken(profileAccessToken)) {
    throw new Error('当前账号尚未完成服务端同步，无法生成恢复码');
  }
  return `${PROFILE_SYNC_PREFIX}${encodeBase64Url(JSON.stringify({
    version: 1,
    profileId,
    profileAccessToken
  }))}`;
}

export function parseProfileSyncCode(value) {
  const code = String(value ?? '').trim();
  if (!code.startsWith(PROFILE_SYNC_PREFIX)) {
    throw new Error('恢复码格式不正确');
  }
  try {
    const payload = JSON.parse(decodeBase64Url(code.slice(PROFILE_SYNC_PREFIX.length)));
    const profileId = String(payload?.profileId ?? '').trim();
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
  safeSetItem(PROFILE_KEY, JSON.stringify(profile));
}

function createProfileId() {
  if (crypto?.randomUUID) return `p_${crypto.randomUUID().replace(/-/g, '').slice(0, 18)}`;
  return `p_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item ?? '').trim()).filter(Boolean);
  return String(value ?? '').split(/[、,\s]+/).map((item) => item.trim()).filter(Boolean);
}

function isValidProfileId(value) {
  return /^[A-Za-z0-9_-]{3,80}$/.test(value) && value !== 'anonymous';
}

function isValidProfileToken(value) {
  return /^[A-Za-z0-9_-]{16,96}$/.test(value);
}

function encodeBase64Url(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeBase64Url(value) {
  const normalized = String(value ?? '').replace(/-/g, '+').replace(/_/g, '/');
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

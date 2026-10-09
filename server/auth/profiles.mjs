// Profile normalisation, identity assertions (single-use nonces) and stored-profile building.
import { createHash, createHmac } from 'node:crypto';
import { normalizeCityName, truncateString, sanitizePublicId, createHttpError } from '../lib/util.mjs';
import {
  hmacText,
  normalizeProfileId,
  safeEqualHex,
  createRouteEditToken,
  createServerProfileId,
  hashSecretToken,
  safeTokenEqual,
  sanitizeEditToken
} from './tokens.mjs';
import { APP_ID, PROFILE_ID_SECRET, PROFILE_LOG_PATH, PROFILE_IDENTITY_ASSERTION_SECRET, IDENTITY_NONCE_LOG_PATH } from '../config/index.mjs';
import { createNonceStore } from './nonce-store.mjs';
import { appendJsonLine, readJsonLines } from '../storage/jsonl.mjs';
import { findLatestByEntityKey, findLatestBySecondaryKey } from '../storage/keyedLookup.mjs';
import { getSavedProfile } from '../storage/records.mjs';
import { withStorageEntityLock } from '../storage/runtime.mjs';
import { consumeProfileRecoveryProof } from './recovery-proof.mjs';

export function normalizeProfile(input = {}) {
  const now = new Date().toISOString();
  const externalIdentity = normalizeProfileIdentity(input?.identity ?? input);
  const baseId = normalizeProfileId(input?.id || input?.profileId);
  const stableId = externalIdentity.key ? `u_${hmacText(externalIdentity.key)}` : baseId;
  return {
    id: stableId,
    previousLocalId: externalIdentity.key && baseId !== stableId ? baseId : '',
    identity: externalIdentity.publicIdentity,
    identityBound: Boolean(externalIdentity.key),
    identityBindingRequired: Boolean(externalIdentity.rejectedReason),
    identityBindingReason: externalIdentity.rejectedReason || '',
    homeCity: input?.homeCity ? normalizeCityName(input.homeCity) : '',
    preferredCities: Array.isArray(input?.preferredCities)
      ? [...new Set(input.preferredCities.map((city) => normalizeCityName(city)).filter(Boolean))].slice(0, 12)
      : [],
    // No silent default budget: empty means no budget constraint.
    budget: truncateString(input?.budget, 40),
    companion: truncateString(input?.companion, 40) || '朋友',
    tempo: truncateString(input?.tempo, 40) || '松弛但不空',
    transport: truncateString(input?.transport, 60) || '步行 + 打车',
    themes: Array.isArray(input?.themes) ? [...new Set(input.themes.map((item) => truncateString(item, 40)).filter(Boolean))].slice(0, 12) : [],
    creatorName: truncateString(input?.creatorName, 60),
    creatorBio: truncateString(input?.creatorBio, 140),
    cloudRegistrationConsentAt: Number.isFinite(Date.parse(String(input?.cloudRegistrationConsentAt ?? '')))
      ? new Date(input.cloudRegistrationConsentAt).toISOString()
      : '',
    accessTokenHash: '',
    updatedAt: now,
    createdAt: truncateString(input?.createdAt, 60) || now
  };
}

function normalizeProfileIdentity(input = {}) {
  const identity = verifiedProfileIdentity(input);
  if (identity?.type === 'wechat-openid') {
    return {
      key: `wechat:${identity.subject}`,
      publicIdentity: {
        type: 'wechat-openid',
        label: `微信 ${identity.subject.slice(0, 4)}****${identity.subject.slice(-4)}`,
        boundAt: new Date().toISOString()
      }
    };
  }
  if (identity?.type === 'phone') {
    return {
      key: `phone:${identity.subject}`,
      publicIdentity: {
        type: 'phone',
        label: `${identity.subject.slice(0, 3)}****${identity.subject.slice(-4)}`,
        boundAt: new Date().toISOString()
      }
    };
  }
  return {
    key: '',
    publicIdentity: null,
    rejectedReason: hasProfileIdentityCandidate(input) ? 'IDENTITY_ASSERTION_REQUIRED' : ''
  };
}

function hasProfileIdentityCandidate(input = {}) {
  const phone = String(input?.phone ?? input?.mobile ?? input?.subject ?? '').replace(/\D/g, '');
  const wechatOpenId = sanitizePublicId(input?.wechatOpenId || input?.openid || input?.openId || input?.subject);
  return /^1\d{10}$/.test(phone) || Boolean(wechatOpenId && String(input?.type ?? input?.provider ?? '').includes('wechat'));
}

const IDENTITY_ASSERTION_MAX_SKEW_MS = 10 * 60 * 1000;

function verifiedProfileIdentity(input = {}) {
  const proof = input?.proof && typeof input.proof === 'object' ? input.proof : input;
  const phone = String(input?.phone ?? input?.mobile ?? proof?.phone ?? proof?.subject ?? '').replace(/\D/g, '');
  const wechatOpenId = sanitizePublicId(
    input?.wechatOpenId || input?.openid || input?.openId || proof?.wechatOpenId || proof?.openid || proof?.openId || proof?.subject
  );
  const requestedType = String(input?.type ?? input?.provider ?? proof?.type ?? proof?.provider ?? '').toLowerCase();
  const type = /^1\d{10}$/.test(phone) ? 'phone' : wechatOpenId && requestedType.includes('wechat') ? 'wechat-openid' : '';
  const subject = type === 'phone' ? phone : wechatOpenId;
  if (!type || !subject || !PROFILE_IDENTITY_ASSERTION_SECRET) return null;

  const issuedAt = truncateString(proof?.issuedAt || proof?.timestamp, 60);
  const nonce = sanitizePublicId(proof?.nonce);
  const signature = String(proof?.signature ?? proof?.identitySignature ?? '')
    .trim()
    .toLowerCase();
  const issuedAtMs = Date.parse(issuedAt);
  if (!issuedAt || !nonce || !signature || !Number.isFinite(issuedAtMs)) return null;
  if (Math.abs(Date.now() - issuedAtMs) > IDENTITY_ASSERTION_MAX_SKEW_MS) return null;

  const payload = `${APP_ID}:${type}:${subject}:${issuedAt}:${nonce}`;
  const expected = createHmac('sha256', PROFILE_IDENTITY_ASSERTION_SECRET).update(payload).digest('hex');
  if (!safeEqualHex(signature, expected)) return null;
  return {
    type,
    subject,
    // M1: single-use key; the assertion itself expires 10 minutes after issuedAt.
    nonceKey: createHash('sha256').update(`${type}:${subject}:${nonce}`).digest('hex'),
    expiresAt: issuedAtMs + IDENTITY_ASSERTION_MAX_SKEW_MS
  };
}

const identityNonceStore = createNonceStore({
  load: async () => readJsonLines(IDENTITY_NONCE_LOG_PATH, 100000),
  persist: async (record) => appendJsonLine(IDENTITY_NONCE_LOG_PATH, { ...record, createdAt: new Date().toISOString() })
});

// M1: a verified identity assertion may bind/recover a profile only once.
async function consumeIdentityAssertion(input = {}) {
  const assertion = verifiedProfileIdentity(input?.identity ?? input);
  if (!assertion) return;
  await withStorageEntityLock('identity-nonce', assertion.nonceKey, async () => {
    const persisted = await findLatestByEntityKey(IDENTITY_NONCE_LOG_PATH, assertion.nonceKey);
    if (persisted || !(await identityNonceStore.consume(assertion.nonceKey, assertion.expiresAt))) {
      throw createHttpError('身份断言已被使用，请重新登录获取新的断言', 409, 'IDENTITY_ASSERTION_REPLAYED');
    }
  });
}

export async function buildStoredProfile(input = {}) {
  let requestedToken = sanitizeEditToken(input?.profileAccessToken);
  const requestedId = normalizeProfileId(input?.id || input?.profileId);
  let normalizedProfile = normalizeProfile(input);
  if (normalizedProfile.identityBound) await consumeIdentityAssertion(input);
  const existingRequested = await getSavedProfile(requestedId);
  if (existingRequested?.deletedAt || existingRequested?.deletionStartedAt || existingRequested?.tombstone) {
    throw createHttpError('该个人资料已注销，不能恢复原账号', 410, 'PROFILE_DELETED');
  }
  const registrationSecret = String(input?.pendingRegistrationSecret ?? '');
  if (registrationSecret && !/^preg_[A-Za-z0-9_-]{43}$/.test(registrationSecret)) {
    throw createHttpError('注册凭据格式无效', 400, 'PROFILE_REGISTRATION_SECRET_INVALID');
  }
  const registrationHash = registrationSecret ? hmacText(registrationSecret, `${PROFILE_ID_SECRET}:profile-registration`) : '';
  let registrationReplay = null;
  if (registrationHash && !requestedToken && !normalizedProfile.identityBound) {
    const candidate = await findLatestBySecondaryKey(PROFILE_LOG_PATH, 'registrationCredentialHash', registrationHash);
    if (candidate) {
      registrationReplay = await getSavedProfile(candidate.id);
      normalizedProfile = { ...normalizedProfile, id: candidate.id, previousLocalId: requestedId !== candidate.id ? requestedId : '' };
    }
    requestedToken = registrationSecret;
  }
  const shouldIssueServerLocalProfile =
    !registrationReplay &&
    !normalizedProfile.identityBound &&
    (!requestedToken || registrationHash) &&
    !input?.recoveryProof &&
    (!requestedId || requestedId === 'anonymous' || !existingRequested);
  if (shouldIssueServerLocalProfile) {
    normalizedProfile = {
      ...normalizedProfile,
      id: createServerProfileId(),
      previousLocalId: requestedId && requestedId !== 'anonymous' ? requestedId : '',
      identityBindingRequired: normalizedProfile.identityBindingRequired,
      identityBindingReason: normalizedProfile.identityBindingReason || (requestedId && requestedId !== 'anonymous' ? 'SERVER_ISSUED_PROFILE_ID' : '')
    };
  }
  const existing = await getSavedProfile(normalizedProfile.id);
  if (existing?.deletedAt || existing?.deletionStartedAt || existing?.tombstone) {
    throw createHttpError('该个人资料已注销，不能恢复原账号', 410, 'PROFILE_DELETED');
  }
  const recovery = consumeProfileRecoveryProof(existing, input);
  let accessToken = requestedToken || createRouteEditToken();
  let accessTokenHash = hashSecretToken(accessToken);

  if (existing) {
    const validExistingToken = Boolean(requestedToken) && safeTokenEqual(hashSecretToken(requestedToken), existing.accessTokenHash);
    // 换设备找回：identityBound 只有在 verifiedProfileIdentity 通过（签名 + 10 分钟
    // 时效 + nonce）后才为 true，且 normalizedProfile.id 就是该身份的 stableId，与
    // existing 按同一 id 命中；此时允许在无旧 accessToken 的情况下轮换新 token。
    // 签名与时效校验本身不放宽，未携带合法断言的请求仍必须持有当前 token。
    const identityRecovery = !validExistingToken && normalizedProfile.identityBound && existing.identityBound === true;
    if (!validExistingToken && !identityRecovery && !recovery.recovered) {
      throw createHttpError('更新已绑定身份需要当前 profile token，请在原设备同步或重新登录', 403, 'PROFILE_TOKEN_REQUIRED');
    }
    if (validExistingToken && !recovery.recovered) {
      accessTokenHash = existing.accessTokenHash || hashSecretToken(accessToken);
      accessToken = requestedToken;
    } else {
      accessToken = createRouteEditToken();
      accessTokenHash = hashSecretToken(accessToken);
    }
  }

  const mergedProfile = existing
    ? normalizeProfile({
        ...existing,
        ...input,
        id: normalizedProfile.id,
        profileId: normalizedProfile.id
      })
    : normalizedProfile;
  const profile = existing
    ? {
        ...mergedProfile,
        identity: normalizedProfile.identityBound ? normalizedProfile.identity : existing.identity,
        identityBound: normalizedProfile.identityBound || Boolean(existing.identityBound),
        identityBindingRequired: normalizedProfile.identityBound
          ? false
          : normalizedProfile.identityBindingRequired || Boolean(existing.identityBindingRequired),
        identityBindingReason: normalizedProfile.identityBound ? '' : normalizedProfile.identityBindingReason || existing.identityBindingReason || '',
        previousLocalId: normalizedProfile.identityBound ? normalizedProfile.previousLocalId : ''
      }
    : normalizedProfile;

  const storedProfile = {
    ...profile,
    createdAt: existing?.createdAt || profile.createdAt,
    accessTokenHash,
    registrationCredentialHash: existing?.registrationCredentialHash || registrationHash,
    usedRecoveryNonces: recovery.usedRecoveryNonces
  };
  const {
    accessTokenHash: _accessTokenHash,
    registrationCredentialHash: _registrationCredentialHash,
    usedRecoveryNonces: _usedRecoveryNonces,
    ...publicProfile
  } = storedProfile;
  return {
    storedProfile,
    publicProfile: {
      ...publicProfile,
      profileAccessToken: accessToken
    }
  };
}

// Registration retries arrive with the old browser-local ID. Resolve their
// actual stored owner before locking so recovery/deletion cannot race a retry
// and revive a revoked token or an account tombstone.
export async function profileMutationKey(input = {}) {
  const secret = String(input.pendingRegistrationSecret ?? '');
  if (/^preg_[A-Za-z0-9_-]{43}$/.test(secret)) {
    const hash = hmacText(secret, `${PROFILE_ID_SECRET}:profile-registration`);
    const candidate = await findLatestBySecondaryKey(PROFILE_LOG_PATH, 'registrationCredentialHash', hash);
    if (candidate) return candidate.id;
  }
  return normalizeProfile(input).id || 'anonymous';
}

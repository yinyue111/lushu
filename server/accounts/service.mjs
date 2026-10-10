// Account flows: register, login, recovery, password change, logout, claim, export, delete.
// Errors are enumeration-safe: unknown phone and wrong password take the same work and the same answer.
import { createHash } from 'node:crypto';
import {
  EMAIL_VERIFICATION_REQUIRED,
  REGISTRATION_INVITE_CODE,
  REGISTRATION_MODE,
  PROFILE_LOG_PATH,
  OPS_AUDIT_LOG_PATH,
  GENERATION_QUOTA_PER_PROFILE
} from '../config/index.mjs';
import { createHttpError, sanitizePublicId, truncateString } from '../lib/util.mjs';
import { cryptoRandomId, hashSecretToken, normalizeProfileId, safeTokenEqual, sanitizeEditToken } from '../auth/tokens.mjs';
import { appendJsonLine } from '../storage/jsonl.mjs';
import { withStorageEntityLock } from '../storage/runtime.mjs';
import { getSavedProfile, getSavedRoutebook } from '../storage/records.mjs';
import { buildStoredProfile } from '../auth/profiles.mjs';
import { withProfileMutationLock } from '../auth/profile-lifecycle.mjs';
import { appendVersionedRoutebook } from '../routebooks/versions.mjs';
import { copyTripSessionToProfile } from '../trips/sessions.mjs';
import { accountStore } from './store.mjs';
import { normalizePhone, maskPhone, phoneHash, phoneLast4 } from './phone.mjs';
import { decryptEmail, emailFields, emailHash, looksLikeEmail, maskEmail, normalizeEmail } from './email.mjs';
import { checkEmailCode, consumeEmailCode, guardMailSend, issueEmailCode } from './emailCodes.mjs';
import { sendMail } from '../mail/transport.mjs';
import { alreadyRegisteredMail, emailChangedMail, passwordChangedMail } from '../mail/templates.mjs';
import { assertPasswordPolicy, hashPassword, verifyPassword, passwordNeedsRehash } from './password.mjs';
import { assertHumanCheck } from './pow.mjs';
import { issueRecoveryCodes, matchRecoveryCode, unusedRecoveryCount } from './recovery.mjs';
import { startSession, endSession, resolveSession } from './session.mjs';
import {
  IP_HUMAN_CHECK_AFTER,
  clearThrottle,
  emailKey,
  globalHumanCheckRequired,
  ipKey,
  lockedError,
  noteGlobalFailure,
  phoneKey,
  recordFailure,
  registerKey,
  throttleState
} from './throttle.mjs';

const INVALID_LOGIN = () => createHttpError('账号或密码不对', 401, 'INVALID_CREDENTIALS');
const INVALID_RECOVERY = () => createHttpError('账号或恢复码不对', 401, 'INVALID_RECOVERY');
const PHONE_INVALID = () => createHttpError('请输入 11 位大陆手机号', 400, 'PHONE_INVALID');
const EMAIL_INVALID = () => createHttpError('邮箱格式不对，检查一下', 400, 'EMAIL_INVALID');
const IDENTIFIER_INVALID = () => createHttpError('请输入手机号或邮箱', 400, 'IDENTIFIER_INVALID');
const DISABLED = () => createHttpError('这个账号已停用。如有疑问，请联系我们', 403, 'ACCOUNT_DISABLED');
/** Same answer whether or not the address has an account. */
const MAIL_SENT = { sent: true };
export const LOGIN_REQUIRED_MESSAGE = '请先登录';

export function loginRequiredError() {
  return createHttpError(LOGIN_REQUIRED_MESSAGE, 401, 'LOGIN_REQUIRED');
}

/** Public view of an account; never includes hashes. */
export function accountView(user, extra = {}) {
  return {
    id: user.id,
    phoneMasked: user.phoneMasked || '',
    emailMasked: user.emailMasked || '',
    emailVerified: Boolean(user.emailHash && user.emailVerifiedAt),
    profileId: user.primaryProfileId,
    status: user.status,
    createdAt: user.createdAt,
    recoveryCodesLeft: unusedRecoveryCount(user.recoveryHashes),
    ...extra
  };
}

/**
 * Login/reset identifier: an email address or a mainland mobile number.
 * @returns {{ kind: 'email' | 'phone', value: string, hash: string, throttleKey: string }}
 */
export function parseIdentifier(input) {
  const raw = input?.identifier ?? input?.email ?? input?.phone ?? '';
  if (looksLikeEmail(raw)) {
    const email = normalizeEmail(raw);
    if (!email) throw EMAIL_INVALID();
    const hash = emailHash(email);
    return { kind: 'email', value: email, hash, throttleKey: emailKey(hash) };
  }
  const phone = normalizePhone(raw);
  if (!phone) throw IDENTIFIER_INVALID();
  const hash = phoneHash(phone);
  return { kind: 'phone', value: phone, hash, throttleKey: phoneKey(hash) };
}

/** Only verified emails can sign in or reset passwords (an unverified one may be someone else's). */
async function findUserByIdentifier(id) {
  if (id.kind === 'phone') return accountStore().findUserByPhoneHash(id.hash);
  const user = await accountStore().findUserByEmailHash(id.hash);
  return user?.emailVerifiedAt ? user : null;
}

function requireEmail(value) {
  const email = normalizeEmail(value);
  if (!email) throw EMAIL_INVALID();
  return email;
}

/** Decrypted address of an account, or ''. */
export function accountEmail(user) {
  return user?.emailEnc ? decryptEmail(user.emailEnc) : '';
}

/** Best-effort security notice; a failed notice never fails the action that triggered it. */
async function notify(to, mail) {
  if (!to) return;
  try {
    await sendMail({ to, ...mail });
  } catch {
    /* logged by the transport */
  }
}

export async function requireAccount(req) {
  const resolved = await resolveSession(req);
  if (!resolved) throw loginRequiredError();
  return resolved;
}

function audit(event) {
  return appendJsonLine(OPS_AUDIT_LOG_PATH, { id: cryptoRandomId(), entityType: 'account', createdAt: new Date().toISOString(), ...event });
}

async function guardThrottles(req, keys) {
  for (const key of keys) {
    const state = await throttleState(key);
    if (state.locked) throw lockedError(state.lockedUntil, Date.now(), key);
  }
}

async function failAttempt(keys) {
  noteGlobalFailure();
  for (const key of keys) await recordFailure(key);
}

async function needsHumanCheckForLogin(req) {
  if (globalHumanCheckRequired()) return true;
  return (await throttleState(ipKey(req))).failures >= IP_HUMAN_CHECK_AFTER;
}

/** A device profile the request can prove it owns (id + access token), or null. */
async function provenDeviceProfile(input) {
  const id = normalizeProfileId(input?.id);
  const token = sanitizeEditToken(input?.token);
  if (id === 'anonymous' || !token) return null;
  const profile = await getSavedProfile(id);
  if (!profile || profile.tombstone || profile.deletedAt || profile.deletionStartedAt) return null;
  return safeTokenEqual(hashSecretToken(token), profile.accessTokenHash) ? profile : null;
}

async function createAccountProfile() {
  return withProfileMutationLock(`new:${cryptoRandomId()}`, async () => {
    const { storedProfile, publicProfile } = await buildStoredProfile({ nickname: '旅行者', cloudRegistrationConsentAt: new Date().toISOString() });
    await appendJsonLine(PROFILE_LOG_PATH, storedProfile);
    return publicProfile;
  });
}

export async function registerAccount(req, res, input = {}) {
  if (REGISTRATION_MODE === 'closed') throw createHttpError('暂时不开放注册', 403, 'REGISTRATION_CLOSED');
  assertHumanCheck(input.humanCheck, 'register');
  await guardThrottles(req, [registerKey(req)]);
  if (REGISTRATION_MODE === 'invite') {
    const code = String(input.inviteCode ?? '').trim();
    if (!REGISTRATION_INVITE_CODE || !safeTokenEqual(code, REGISTRATION_INVITE_CODE)) {
      await recordFailure(registerKey(req));
      throw createHttpError(code ? '邀请码不对' : '现在是内测，注册需要邀请码', 403, code ? 'INVITE_CODE_INVALID' : 'INVITE_CODE_REQUIRED');
    }
  }
  if (input.acceptPrivacy !== true) throw createHttpError('请先阅读并同意隐私说明', 400, 'PRIVACY_CONSENT_REQUIRED');
  const email = requireEmail(input.email);
  const eHash = emailHash(email);
  // Phone is optional: when given it must be valid and becomes a second login name.
  const phoneText = String(input.phone ?? '').trim();
  const phone = phoneText ? normalizePhone(phoneText) : '';
  if (phoneText && !phone) throw PHONE_INVALID();
  assertPasswordPolicy(input.password, { phone });
  const codeGiven = Boolean(String(input.emailCode ?? '').trim());
  if (EMAIL_VERIFICATION_REQUIRED && !codeGiven) throw createHttpError('请填写邮箱收到的验证码', 400, 'EMAIL_CODE_REQUIRED');
  const codeRecord = codeGiven ? await checkEmailCode({ purpose: 'register', emailHashValue: eHash, code: input.emailCode }) : null;
  await recordFailure(registerKey(req)); // counts every sign-up attempt from this client, successful or not
  const passwordHash = await hashPassword(input.password);
  const pHash = phone ? phoneHash(phone) : null;
  const device = await provenDeviceProfile(input.deviceProfile);
  const deviceFree = device && !(await accountStore().findUserIdByProfile(device.id));
  const { codes, hashes } = issueRecoveryCodes();
  const now = new Date().toISOString();
  const user = await withStorageEntityLock('account-email', eHash, () =>
    withStorageEntityLock('account-phone', pHash ?? `none:${eHash}`, async () => {
      if (await accountStore().findUserByEmailHash(eHash)) {
        throw createHttpError('这个邮箱已经注册过了。直接登录，或者用「忘了密码」重设', 409, 'EMAIL_TAKEN');
      }
      if (pHash && (await accountStore().findUserByPhoneHash(pHash))) {
        throw createHttpError('这个手机号不能注册。如果是你的号，直接登录，或用恢复码重设密码', 409, 'PHONE_TAKEN');
      }
      const profileId = deviceFree ? device.id : (await createAccountProfile()).id;
      return accountStore().createUser({
        id: `u_${cryptoRandomId()
          .replace(/[^A-Za-z0-9]/g, '')
          .slice(0, 20)}`,
        phoneHash: pHash,
        phoneMasked: phone ? maskPhone(phone) : '',
        phoneLast4: phone ? phoneLast4(phone) : '',
        ...emailFields(email, codeRecord ? now : null),
        passwordHash,
        recoveryHashes: hashes,
        primaryProfileId: profileId,
        status: 'active',
        createdAt: now
      });
    })
  );
  if (codeRecord) await consumeEmailCode(codeRecord);
  await startSession(req, res, user);
  await accountStore().updateUser(user.id, { lastLoginAt: new Date().toISOString() });
  return { account: accountView(user), recoveryCodes: codes, usedDeviceProfile: Boolean(deviceFree) };
}

/**
 * Step 1 of sign-up: mail a code. Answers the same whether or not the address is taken; a taken address
 * gets an "already registered" notice instead of a code.
 */
export async function sendRegisterCode(req, _res, input = {}) {
  if (REGISTRATION_MODE === 'closed') throw createHttpError('暂时不开放注册', 403, 'REGISTRATION_CLOSED');
  const email = requireEmail(input.email);
  const eHash = emailHash(email);
  assertHumanCheck(input.humanCheck, 'mail');
  await guardMailSend(req, eHash);
  if (await accountStore().findUserByEmailHash(eHash)) {
    await notify(email, alreadyRegisteredMail());
    // Keep the resend timer identical for taken and free addresses.
    await accountStore().createEmailCode({
      id: `ec_${cryptoRandomId()
        .replace(/[^A-Za-z0-9]/g, '')
        .slice(0, 20)}`,
      purpose: 'register',
      emailHash: eHash,
      emailEnc: '',
      userId: null,
      codeHash: 'none',
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      createdAt: new Date().toISOString()
    });
  } else {
    await issueEmailCode({ purpose: 'register', email, emailHashValue: eHash });
  }
  return { ...MAIL_SENT, emailMasked: maskEmail(email) };
}

export async function loginAccount(req, res, input = {}) {
  const id = parseIdentifier(input);
  const keys = [ipKey(req), id.throttleKey];
  await guardThrottles(req, keys);
  if (await needsHumanCheckForLogin(req)) assertHumanCheck(input.humanCheck, 'login');
  const user = await findUserByIdentifier(id);
  const ok = await verifyPassword(input.password, user?.passwordHash ?? '');
  if (!ok || !user) {
    await failAttempt(keys);
    throw INVALID_LOGIN();
  }
  if (user.status !== 'active') throw DISABLED();
  await clearThrottle(id.throttleKey);
  const patch = { lastLoginAt: new Date().toISOString() };
  if (passwordNeedsRehash(user.passwordHash)) patch.passwordHash = await hashPassword(input.password);
  const updated = await accountStore().updateUser(user.id, patch);
  await startSession(req, res, updated);
  return { account: accountView(updated) };
}

export async function resetPasswordWithRecovery(req, res, input = {}) {
  if (String(input.emailCode ?? '').trim()) return resetPasswordWithEmail(req, res, input);
  const id = parseIdentifier(input);
  const hash = id.hash;
  const keys = [ipKey(req), `${id.kind}:reset-${hash.slice(0, 34)}`];
  await guardThrottles(req, keys);
  assertHumanCheck(input.humanCheck, 'reset');
  assertPasswordPolicy(input.password, { phone: id.kind === 'phone' ? id.value : '' });
  return withStorageEntityLock(`account-${id.kind}`, hash, async () => {
    const user = await findUserByIdentifier(id);
    const index = user ? matchRecoveryCode(user.recoveryHashes, input.recoveryCode) : -1;
    // Same scrypt work whether or not the account exists.
    const passwordHash = await hashPassword(input.password);
    if (!user || index < 0) {
      await failAttempt(keys);
      throw INVALID_RECOVERY();
    }
    if (user.status !== 'active') throw DISABLED();
    const now = new Date().toISOString();
    const recoveryHashes = user.recoveryHashes.map((entry, i) => (i === index ? { ...entry, usedAt: now } : entry));
    const updated = await accountStore().updateUser(user.id, { passwordHash, recoveryHashes, credentialsChangedAt: now });
    await accountStore().revokeUserSessions(user.id);
    await clearThrottle(id.throttleKey);
    await startSession(req, res, updated);
    if (updated.emailVerifiedAt) await notify(accountEmail(updated), passwordChangedMail());
    return { account: accountView(updated) };
  });
}

/** Forgot password, step 1: mail a reset code if the address belongs to an account (same answer either way). */
export async function sendResetCode(req, _res, input = {}) {
  const email = requireEmail(input.email);
  const eHash = emailHash(email);
  assertHumanCheck(input.humanCheck, 'mail');
  await guardMailSend(req, eHash);
  const user = await accountStore().findUserByEmailHash(eHash);
  if (user?.emailVerifiedAt && user.status === 'active') await issueEmailCode({ purpose: 'reset', email, emailHashValue: eHash, userId: user.id });
  return { ...MAIL_SENT, emailMasked: maskEmail(email) };
}

/** Forgot password, step 2: code + new password. Signs out every device, then signs this one in. */
export async function resetPasswordWithEmail(req, res, input = {}) {
  const email = requireEmail(input.email ?? input.identifier);
  const eHash = emailHash(email);
  await guardThrottles(req, [ipKey(req)]);
  assertPasswordPolicy(input.password, {});
  const passwordHash = await hashPassword(input.password);
  return withStorageEntityLock('account-email', eHash, async () => {
    const record = await checkEmailCode({ purpose: 'reset', emailHashValue: eHash, code: input.emailCode });
    const user = record.userId ? await accountStore().getUser(record.userId) : null;
    if (!user || user.emailHash !== eHash || user.status === 'deleted') throw createHttpError('验证码不对或已过期，请重新获取', 400, 'EMAIL_CODE_INVALID');
    if (user.status !== 'active') throw DISABLED();
    await consumeEmailCode(record);
    const now = new Date().toISOString();
    const updated = await accountStore().updateUser(user.id, { passwordHash, credentialsChangedAt: now });
    await accountStore().revokeUserSessions(user.id);
    await clearThrottle(emailKey(eHash));
    await startSession(req, res, updated);
    await notify(email, passwordChangedMail());
    return { account: accountView(updated) };
  });
}

/** Add or change the account email, step 1: password check, then a code to the new address. */
export async function sendChangeEmailCode(req, _res, input = {}) {
  const { user } = await requireAccount(req);
  await guardThrottles(req, [ipKey(req)]);
  try {
    await requirePassword(user, input.password);
  } catch (error) {
    await failAttempt([ipKey(req)]);
    throw error;
  }
  const email = requireEmail(input.email);
  const eHash = emailHash(email);
  if (user.emailHash === eHash && user.emailVerifiedAt) throw createHttpError('这就是你现在的邮箱', 400, 'EMAIL_UNCHANGED');
  await guardMailSend(req, eHash);
  const owner = await accountStore().findUserByEmailHash(eHash);
  if (owner && owner.id !== user.id) throw createHttpError('这个邮箱已经绑定了别的账号', 409, 'EMAIL_TAKEN');
  await issueEmailCode({ purpose: 'change', email, emailHashValue: eHash, userId: user.id });
  return { ...MAIL_SENT, emailMasked: maskEmail(email) };
}

/** Step 2: confirm the code. The old address (if any) gets a notice. */
export async function confirmChangeEmail(req, _res, input = {}) {
  const { user } = await requireAccount(req);
  const email = requireEmail(input.email);
  const eHash = emailHash(email);
  return withStorageEntityLock('account-email', eHash, async () => {
    const record = await checkEmailCode({ purpose: 'change', emailHashValue: eHash, code: input.emailCode, userId: user.id });
    const oldEmail = user.emailVerifiedAt ? accountEmail(user) : '';
    const updated = await accountStore().updateUser(user.id, emailFields(email, new Date().toISOString()));
    await consumeEmailCode(record);
    await audit({ entityId: user.id, action: oldEmail ? 'email-changed' : 'email-added', actor: 'user', reason: oldEmail ? '用户更换邮箱' : '用户添加邮箱' });
    if (oldEmail && oldEmail !== email) await notify(oldEmail, emailChangedMail(maskEmail(email)));
    return { account: accountView(updated) };
  });
}

async function requirePassword(user, password) {
  if (!(await verifyPassword(password, user.passwordHash))) throw createHttpError('当前密码不对', 403, 'PASSWORD_MISMATCH');
}

export async function changePassword(req, res, input = {}) {
  const { user } = await requireAccount(req);
  await guardThrottles(req, [ipKey(req)]);
  try {
    await requirePassword(user, input.currentPassword);
  } catch (error) {
    await failAttempt([ipKey(req)]);
    throw error;
  }
  assertPasswordPolicy(input.password, {});
  const updated = await accountStore().updateUser(user.id, {
    passwordHash: await hashPassword(input.password),
    credentialsChangedAt: new Date().toISOString()
  });
  await accountStore().revokeUserSessions(user.id);
  await startSession(req, res, updated);
  if (updated.emailVerifiedAt) await notify(accountEmail(updated), passwordChangedMail());
  return { account: accountView(updated) };
}

export async function regenerateRecoveryCodes(req, input = {}) {
  const { user } = await requireAccount(req);
  await requirePassword(user, input.password);
  const { codes, hashes } = issueRecoveryCodes();
  const updated = await accountStore().updateUser(user.id, { recoveryHashes: hashes });
  return { account: accountView(updated), recoveryCodes: codes };
}

export async function logoutAccount(req, res, { everywhere = false } = {}) {
  const resolved = await resolveSession(req);
  if (resolved && everywhere) await accountStore().revokeUserSessions(resolved.user.id);
  await endSession(req, res);
  return { loggedOut: true, everywhere };
}

export async function currentAccount(req) {
  const resolved = await resolveSession(req);
  if (!resolved) return null;
  const sessions = await accountStore().countActiveSessions(resolved.user.id);
  return accountView(resolved.user, { activeSessions: sessions });
}

/** Profiles whose data belongs to the signed-in account: the primary one plus claimed device profiles. */
export async function accountProfileIds(user) {
  return [user.primaryProfileId, ...(await accountStore().listLinkedProfiles(user.id))];
}

/**
 * First login on a device: link the device profile and move this device's drafts (proven by their
 * edit tokens) to the account. Drafts owned by somebody else are never touched. Idempotent.
 */
export async function claimDeviceData(req, res, input = {}) {
  const { user } = await requireAccount(req);
  const primary = user.primaryProfileId;
  const result = { linkedProfile: false, profileOwnedElsewhere: false, claimed: 0, alreadyYours: 0, skipped: 0, tripsCopied: 0 };
  const device = await provenDeviceProfile(input.deviceProfile);
  const ownProfiles = new Set(await accountProfileIds(user));
  if (device && !ownProfiles.has(device.id)) {
    const owner = await accountStore().linkProfile(device.id, user.id, 'claim');
    if (owner === user.id) {
      ownProfiles.add(device.id);
      result.linkedProfile = true;
    } else result.profileOwnedElsewhere = true;
  }
  const drafts = Array.isArray(input.drafts) ? input.drafts.slice(0, 200) : [];
  for (const item of drafts) {
    const id = sanitizePublicId(item?.id);
    const token = sanitizeEditToken(item?.editToken);
    if (!id) continue;
    const outcome = await withStorageEntityLock('routebook', id, async () => {
      const current = await getSavedRoutebook(id);
      if (!current || current.tombstone || current.deletedAt) return 'skipped';
      const owner = normalizeProfileId(current.profileId);
      if (owner === primary) return 'alreadyYours';
      const tokenOk = token && current.editTokenHash && safeTokenEqual(hashSecretToken(token), current.editTokenHash);
      if (!tokenOk || !(owner === 'anonymous' || ownProfiles.has(owner))) return 'skipped';
      const version = Math.max(1, Number(current.version) || 1);
      await appendVersionedRoutebook(
        { ...current, profileId: primary, version: version + 1, parentVersion: version, updatedAt: new Date().toISOString(), changeReason: '登录后归入账号' },
        'claimed-by-account'
      );
      if (owner !== 'anonymous' && (await copyTripSessionToProfile(id, owner, primary))) result.tripsCopied += 1;
      return 'claimed';
    });
    result[outcome] += 1;
  }
  if (result.claimed || result.linkedProfile) await startSession(req, res, user); // privilege changed: rotate
  return result;
}

export async function deleteAccount(req, res, input = {}, { deleteProfile }) {
  const { user } = await requireAccount(req);
  await requirePassword(user, input.password);
  const removed = [];
  for (const profileId of await accountProfileIds(user)) {
    removed.push(await deleteProfile(req, { confirmation: 'DELETE', profileId }));
  }
  // The readable address goes at once; only the HMAC stays with the deleted row (like the phone).
  await accountStore().updateUser(user.id, { status: 'deleted', emailEnc: null, emailMasked: '' });
  await accountStore().revokeUserSessions(user.id);
  await endSession(req, res);
  await audit({ entityId: user.id, action: 'self-delete', actor: 'user', reason: '用户注销账号' });
  return { deleted: true, profiles: removed.length };
}

// ---------------------------------------------------------------- ops (admin token only)
const opsView = (user, extra = {}) => ({
  id: user.id,
  phoneMasked: user.phoneMasked || '',
  emailMasked: user.emailMasked || '',
  emailVerified: Boolean(user.emailHash && user.emailVerifiedAt),
  status: user.status,
  profileId: user.primaryProfileId,
  createdAt: user.createdAt,
  lastLoginAt: user.lastLoginAt,
  recoveryCodesLeft: unusedRecoveryCount(user.recoveryHashes),
  generationQuota: user.generationQuota ?? null,
  ...extra
});

export async function opsListUsers({ query = '', limit = 50 } = {}) {
  const text = String(query ?? '').trim();
  const email = looksLikeEmail(text) ? normalizeEmail(text) : '';
  const phone = email ? '' : normalizePhone(text);
  const last4 = !phone && !email && /^\d{4}$/.test(text) ? text : '';
  if (text && !phone && !last4 && !email) throw createHttpError('按完整邮箱、完整手机号或手机号后 4 位搜索', 400, 'OPS_USER_QUERY_INVALID');
  const users = await accountStore().listUsers({
    phoneHash: phone ? phoneHash(phone) : '',
    emailHash: email ? emailHash(email) : '',
    last4,
    limit: Math.min(200, Math.max(1, Number(limit) || 50))
  });
  return Promise.all(users.map(async (user) => opsView(user, { activeSessions: await accountStore().countActiveSessions(user.id) })));
}

function opsReason(input) {
  const reason = truncateString(String(input?.reason ?? '').trim(), 200);
  if (reason.length < 4) throw createHttpError('请写明原因（至少 4 个字）', 400, 'OPS_REASON_REQUIRED');
  return reason;
}

export async function opsUpdateUser(req, userId, input = {}, actor) {
  const id = sanitizePublicId(userId);
  const user = await accountStore().getUser(id);
  if (!user || user.status === 'deleted') throw createHttpError('账号不存在', 404, 'ACCOUNT_NOT_FOUND');
  const reason = opsReason(input);
  const action = String(input.action ?? '');
  /** @type {Record<string, any>} */
  let extra = {};
  if (action === 'disable' || action === 'enable') {
    await accountStore().updateUser(id, { status: action === 'disable' ? 'disabled' : 'active' });
    if (action === 'disable') await accountStore().revokeUserSessions(id);
  } else if (action === 'revoke-sessions') {
    extra.revoked = await accountStore().revokeUserSessions(id);
  } else if (action === 'issue-recovery') {
    // One extra one-time code, handed to the verified owner out of band. Ops never sets passwords.
    const { codes, hashes } = issueRecoveryCodes(1, 'ops');
    await accountStore().updateUser(id, { recoveryHashes: [...(user.recoveryHashes ?? []), ...hashes] });
    extra = { recoveryCode: codes[0] };
  } else if (action === 'set-quota') {
    const quota = input.quota === null || input.quota === '' ? null : Math.max(0, Math.min(1000, Math.floor(Number(input.quota))));
    if (quota !== null && !Number.isFinite(quota)) throw createHttpError('配额需为 0–1000 的整数', 400, 'OPS_QUOTA_INVALID');
    await accountStore().updateUser(id, { generationQuota: quota });
  } else {
    throw createHttpError('不支持的账号操作', 400, 'OPS_ACCOUNT_ACTION_INVALID');
  }
  await audit({ entityId: id, action, actor, reason, ...(action === 'set-quota' ? { quota: input.quota ?? null } : {}) });
  return { user: opsView(await accountStore().getUser(id)), ...extra };
}

/** Generation quota for an account: per-user override, else the default per-profile quota. */
export function quotaForUser(user) {
  return Number.isInteger(user?.generationQuota) ? user.generationQuota : GENERATION_QUOTA_PER_PROFILE;
}

export const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');

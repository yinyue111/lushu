// Admin console login: separate from user accounts. Password (scrypt) + TOTP (first login must bind it),
// one-time backup codes, lockout after N wrong attempts, idle-timeout sessions in their own cookie,
// CSRF token for every write. The legacy X-Routebook-Admin-Token never opens an admin session.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AUTH_COOKIE_SECURE, PROFILE_ID_SECRET } from '../config/index.mjs';
import { getConfig, encryptSecret, decryptSecret } from '../config/runtime.mjs';
import { hashPassword, verifyPassword, PASSWORD_MIN } from '../accounts/password.mjs';
import { createHttpError, cryptoRandomId } from './util.mjs';
import { adminStore } from './store.mjs';
import { generateTotpSecret, otpauthUrl, verifyTotp } from './totp.mjs';
import { generateRecoveryCode, normalizeRecoveryCode } from '../accounts/recovery.mjs';

export const ADMIN_COOKIE = AUTH_COOKIE_SECURE ? '__Host-lushu_admin' : 'lushu_admin';
export const ADMIN_ROLES = /** @type {const} */ (['operator', 'admin']);
const ABSOLUTE_SESSION_MS = 12 * 60 * 60 * 1000;
const ENROLL_TTL_MS = 10 * 60 * 1000;
const BACKUP_CODE_COUNT = 8;
const sha = (value) => createHash('sha256').update(String(value)).digest('hex');
const hashSid = (sid) => sha(`admin-sid:v1:${sid}`);
const hashBackup = (code) => createHmac('sha256', `${PROFILE_ID_SECRET}:admin-backup`).update(normalizeRecoveryCode(code)).digest('hex');
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;

export function clientIp(req) {
  return String(req?.socket?.remoteAddress ?? '').slice(0, 64);
}

function readCookie(req) {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === ADMIN_COOKIE) {
      const value = part.slice(index + 1).trim();
      return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : '';
    }
  }
  return '';
}
function setCookie(res, value, maxAgeSeconds) {
  const cookie = [
    `${ADMIN_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
    ...(AUTH_COOKIE_SECURE ? ['Secure'] : [])
  ].join('; ');
  const existing = res.getHeader?.('set-cookie');
  const list = Array.isArray(existing) ? existing : existing ? [String(existing)] : [];
  res.setHeader('set-cookie', [...list, cookie]);
}

export function adminView(admin) {
  return (
    admin && {
      id: admin.id,
      username: admin.username,
      role: admin.role,
      status: admin.status,
      totpConfirmed: Boolean(admin.totpConfirmed),
      backupCodesLeft: (admin.backupCodeHashes ?? []).filter((c) => !c.usedAt).length,
      createdAt: admin.createdAt,
      lastLoginAt: admin.lastLoginAt
    }
  );
}

/** Creates an admin account. Returns a one-time initial password; TOTP is bound at first login. */
export async function createAdminAccount({ username, role, password = '' }) {
  const name = String(username ?? '')
    .trim()
    .toLowerCase();
  if (!USERNAME_RE.test(name)) throw createHttpError('用户名 3–32 位：小写字母、数字、. _ -', 400, 'ADMIN_USERNAME_INVALID');
  if (!ADMIN_ROLES.includes(role)) throw createHttpError('角色只能是 operator 或 admin', 400, 'ADMIN_ROLE_INVALID');
  const initialPassword = password || randomBytes(12).toString('base64url');
  if (initialPassword.length < Math.max(PASSWORD_MIN, 12)) throw createHttpError('后台密码至少 12 位', 400, 'ADMIN_PASSWORD_WEAK');
  const admin = await adminStore().createAdmin({
    id: `adm_${cryptoRandomId()}`,
    username: name,
    passwordHash: await hashPassword(initialPassword),
    totpSecretEnc: encryptSecret(generateTotpSecret()),
    role
  });
  return { admin, initialPassword };
}

/** Admin resets someone's 2FA: new secret, must bind again at next login; their sessions end. */
export async function resetAdminTotp(adminId) {
  const admin = await adminStore().updateAdmin(adminId, {
    totpSecretEnc: encryptSecret(generateTotpSecret()),
    totpConfirmed: false,
    backupCodeHashes: [],
    lastTotpStep: 0
  });
  if (!admin) throw createHttpError('后台账号不存在', 404, 'ADMIN_NOT_FOUND');
  await adminStore().deleteAdminSessions(adminId);
  return admin;
}

const enrollToken = (admin, exp) =>
  `${admin.id}.${exp}.${createHmac('sha256', PROFILE_ID_SECRET).update(`admin-enroll:${admin.id}:${exp}:${admin.passwordHash}`).digest('base64url')}`;
async function checkEnrollToken(token) {
  const [id, exp, mac] = String(token ?? '').split('.');
  if (!id || !exp || !mac || Number(exp) < Date.now()) return null;
  const admin = await adminStore().getAdmin(id);
  if (!admin) return null;
  const expected = enrollToken(admin, exp).split('.')[2];
  return expected.length === mac.length && timingSafeEqual(Buffer.from(expected), Buffer.from(mac)) ? admin : null;
}

async function recordFailure(admin) {
  const attempts = (admin.failedAttempts ?? 0) + 1;
  const lockAt = getConfig('admin.lockoutAttempts');
  const patch =
    attempts >= lockAt
      ? { failedAttempts: 0, lockedUntil: new Date(Date.now() + getConfig('admin.lockoutMinutes') * 60000).toISOString() }
      : { failedAttempts: attempts };
  await adminStore().updateAdmin(admin.id, patch);
}
async function remainingLoginAttempts(adminId) {
  const fresh = await adminStore().getAdmin(adminId);
  if (!fresh) return null;
  if (fresh.lockedUntil && Date.parse(fresh.lockedUntil) > Date.now()) return 0;
  const lockAt = getConfig('admin.lockoutAttempts');
  return Math.max(0, lockAt - (fresh.failedAttempts ?? 0));
}

const LOGIN_FAILED = (remainingAttempts = null) => {
  const base = '用户名、密码或动态码不对';
  const message = Number.isFinite(remainingAttempts) ? `${base}。还能再试 ${remainingAttempts} 次。` : base;
  const error = createHttpError(message, 401, 'ADMIN_LOGIN_FAILED');
  if (Number.isFinite(remainingAttempts)) error.remainingAttempts = remainingAttempts;
  return error;
};

/**
 * Step 1+2 in one call. Without a confirmed TOTP the answer is an enrollment challenge (no session).
 * @returns {Promise<{ session?: any, enroll?: any, admin: any }>}
 */
export async function adminLogin(req, res, input = {}) {
  const admin = await adminStore().findAdminByUsername(
    String(input.username ?? '')
      .trim()
      .toLowerCase()
  );
  if (!admin || admin.status !== 'active') {
    await verifyPassword(String(input.password ?? ''), null).catch(() => false); // similar timing
    throw LOGIN_FAILED();
  }
  if (admin.lockedUntil && Date.parse(admin.lockedUntil) > Date.now()) {
    const minutes = Math.ceil((Date.parse(admin.lockedUntil) - Date.now()) / 60000);
    throw Object.assign(createHttpError(`输错次数太多，请 ${minutes} 分钟后再试`, 429, 'ADMIN_LOCKED'), { retryAfterSeconds: minutes * 60 });
  }
  if (!(await verifyPassword(String(input.password ?? ''), admin.passwordHash).catch(() => false))) {
    await recordFailure(admin);
    throw LOGIN_FAILED(await remainingLoginAttempts(admin.id));
  }
  const secret = decryptSecret(admin.totpSecretEnc);
  if (!admin.totpConfirmed) {
    const exp = Date.now() + ENROLL_TTL_MS;
    return { admin, enroll: { token: enrollToken(admin, exp), secret, otpauthUrl: otpauthUrl({ secret, account: admin.username }) } };
  }
  let ok = false;
  if (input.backupCode) {
    const hash = hashBackup(input.backupCode);
    const codes = admin.backupCodeHashes ?? [];
    const index = codes.findIndex((c) => !c.usedAt && c.hash.length === hash.length && timingSafeEqual(Buffer.from(c.hash), Buffer.from(hash)));
    if (index >= 0) {
      await adminStore().updateAdmin(admin.id, { backupCodeHashes: codes.map((c, i) => (i === index ? { ...c, usedAt: new Date().toISOString() } : c)) });
      ok = true;
    }
  } else {
    const step = verifyTotp(secret, input.totp);
    ok = step > 0 && (await adminStore().consumeTotpStep(admin.id, step));
  }
  if (!ok) {
    await recordFailure(admin);
    throw LOGIN_FAILED(await remainingLoginAttempts(admin.id));
  }
  await adminStore().updateAdmin(admin.id, { failedAttempts: 0, lockedUntil: null });
  return { admin, session: await startAdminSession(res, admin) };
}

/** Confirms the TOTP binding (first login / after reset). Returns backup codes once + a session. */
export async function adminEnroll(req, res, input = {}) {
  const admin = await checkEnrollToken(input.token);
  if (!admin || admin.totpConfirmed) throw createHttpError('绑定已过期，请重新登录', 401, 'ADMIN_ENROLL_EXPIRED');
  const step = verifyTotp(decryptSecret(admin.totpSecretEnc), input.totp);
  if (!step || !(await adminStore().consumeTotpStep(admin.id, step)))
    throw createHttpError('动态码不对，请看验证器 App 上的 6 位数', 400, 'ADMIN_TOTP_INVALID');
  const codes = Array.from({ length: BACKUP_CODE_COUNT }, generateRecoveryCode);
  const fresh = await adminStore().updateAdmin(admin.id, {
    totpConfirmed: true,
    failedAttempts: 0,
    lockedUntil: null,
    backupCodeHashes: codes.map((code) => ({ hash: hashBackup(code), usedAt: null }))
  });
  return { admin: fresh, backupCodes: codes, session: await startAdminSession(res, fresh) };
}

async function startAdminSession(res, admin) {
  const sid = randomBytes(32).toString('base64url');
  const csrf = randomBytes(24).toString('base64url');
  const now = Date.now();
  await adminStore().createSession({
    sidHash: hashSid(sid),
    adminId: admin.id,
    csrfHash: sha(csrf),
    expiresAt: new Date(now + ABSOLUTE_SESSION_MS).toISOString(),
    lastSeenAt: new Date(now).toISOString(),
    createdAt: new Date(now).toISOString()
  });
  setCookie(res, sid, ABSOLUTE_SESSION_MS / 1000);
  return { csrfToken: csrf, idleMinutes: getConfig('admin.sessionIdleMinutes') };
}

export async function adminLogout(req, res) {
  const sid = readCookie(req);
  if (sid) await adminStore().deleteSession(hashSid(sid));
  setCookie(res, '', 0);
}

/**
 * Resolves the admin of this request (cookie session). Writes also need the CSRF header.
 * @returns {Promise<{ admin: any, session: any }>}
 */
export async function requireAdminSession(req, { write = false } = {}) {
  const sid = readCookie(req);
  const session = sid ? await adminStore().getSession(hashSid(sid)) : null;
  const now = Date.now();
  const idleMs = getConfig('admin.sessionIdleMinutes') * 60000;
  if (!session || Date.parse(session.expiresAt) <= now || Date.parse(session.lastSeenAt ?? session.createdAt) + idleMs <= now) {
    if (session) await adminStore().deleteSession(session.sidHash);
    throw createHttpError('请先登录管理后台', 401, 'ADMIN_LOGIN_REQUIRED');
  }
  const admin = await adminStore().getAdmin(session.adminId);
  if (!admin || admin.status !== 'active' || !admin.totpConfirmed) throw createHttpError('请先登录管理后台', 401, 'ADMIN_LOGIN_REQUIRED');
  if (write) {
    const given = String(req.headers['x-admin-csrf'] ?? '');
    if (!given || sha(given) !== session.csrfHash) throw createHttpError('页面已过期，请刷新后再试', 403, 'ADMIN_CSRF_INVALID');
  }
  // Touch at most every 30 s to keep writes cheap.
  if (now - Date.parse(session.lastSeenAt ?? session.createdAt) > 30000) await adminStore().touchSession(session.sidHash, new Date(now).toISOString());
  return { admin, session };
}

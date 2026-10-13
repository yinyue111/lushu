// Account API: phone + password login. Disabled (404) while AUTH_MODE=access-code.
import { peekGenerationQuota } from '../ai/generationGuard.mjs';
import { decryptEmail } from '../accounts/email.mjs';
import { route } from '../http/router.mjs';
import { recordFunnelEvent } from '../analytics/funnelEvents.mjs';
import { readJsonBody, sendJson } from '../http/response.mjs';
import { enforceRateLimit } from '../http/rate-limit.mjs';
import { AUTH_ENABLED, AUTH_MODE, AUTH_POW_DIFFICULTY, EMAIL_VERIFICATION_REQUIRED } from '../config/index.mjs';
import { getConfig } from '../config/runtime.mjs';
import { mailDelivers } from '../mail/transport.mjs';
import { createHttpError } from '../lib/util.mjs';
import { issueChallenge } from '../accounts/pow.mjs';
import {
  accountProfileIds,
  changePassword,
  claimDeviceData,
  confirmChangeEmail,
  currentAccount,
  deleteAccount,
  loginAccount,
  logoutAccount,
  regenerateRecoveryCodes,
  registerAccount,
  requireAccount,
  resetPasswordWithRecovery,
  sendChangeEmailCode,
  sendRegisterCode,
  sendResetCode,
  quotaForUser
} from '../accounts/service.mjs';
import { buildProfileExport, deleteProfileData, requireProfileOwnerAccess, withProfileMutationLock } from '../auth/profile-lifecycle.mjs';

function requireEnabled() {
  if (!AUTH_ENABLED) throw createHttpError('接口不存在', 404, 'API_NOT_FOUND');
}

const post = (path, handler) =>
  route('POST', path, async ({ req, res }) => {
    requireEnabled();
    enforceRateLimit(req);
    const body = await readJsonBody(req);
    return sendJson(res, 200, { ok: true, ...(await handler(req, res, body)) });
  });

export const authRoutes = [
  route('GET', '/api/auth/config', async ({ req, res }) => {
    enforceRateLimit(req, 'public-config');
    return sendJson(res, 200, {
      ok: true,
      mode: AUTH_MODE,
      registration: AUTH_ENABLED ? getConfig('registration.mode') : 'closed',
      humanCheckDifficulty: AUTH_POW_DIFFICULTY,
      emailVerificationRequired: EMAIL_VERIFICATION_REQUIRED,
      emailDelivery: mailDelivers()
    });
  }),
  route('GET', '/api/auth/me', async ({ req, res }) => {
    enforceRateLimit(req, 'public-read');
    const account = AUTH_ENABLED ? await currentAccount(req) : null;
    let generation = null;
    if (account?.profileId) {
      generation = await peekGenerationQuota(account.profileId, { quota: quotaForUser({ generationQuota: /** @type {any} */ (account).generationQuota }) });
    }
    return sendJson(res, 200, { ok: true, mode: AUTH_MODE, account, generation });
  }),
  route('GET', '/api/auth/challenge', async ({ req, res, url }) => {
    requireEnabled();
    enforceRateLimit(req);
    const purpose = String(url.searchParams.get('purpose') ?? '');
    if (!['register', 'login', 'reset', 'mail'].includes(purpose)) throw createHttpError('不支持的安全检查', 400, 'HUMAN_CHECK_PURPOSE_INVALID');
    return sendJson(res, 200, { ok: true, ...issueChallenge(purpose) });
  }),
  post('/api/auth/register/code', sendRegisterCode),
  post('/api/auth/register', async (req, res, body) => {
    const result = await registerAccount(req, res, body);
    await recordFunnelEvent('register_complete', { profileId: result?.account?.profileId || '', aliasOf: String(body?.deviceProfile?.id ?? '') });
    return result;
  }),
  post('/api/auth/reset-password/code', sendResetCode),
  post('/api/auth/email/code', sendChangeEmailCode),
  post('/api/auth/email', confirmChangeEmail),
  post('/api/auth/login', loginAccount),
  post('/api/auth/reset-password', resetPasswordWithRecovery),
  post('/api/auth/password', changePassword),
  post('/api/auth/recovery-codes', (req, _res, body) => regenerateRecoveryCodes(req, body)),
  post('/api/auth/logout', (req, res) => logoutAccount(req, res)),
  post('/api/auth/logout-all', (req, res) => logoutAccount(req, res, { everywhere: true })),
  post('/api/auth/claim', claimDeviceData),
  post('/api/auth/delete', (req, res, body) => deleteAccount(req, res, body, { deleteProfile: deleteProfileData })),
  route('GET', '/api/auth/export', async ({ req, res }) => {
    requireEnabled();
    enforceRateLimit(req, 'core-write');
    const { user } = await requireAccount(req);
    const profiles = [];
    for (const profileId of await accountProfileIds(user)) {
      profiles.push(
        await withProfileMutationLock(profileId, async () => {
          const actor = await requireProfileOwnerAccess(req, profileId);
          return buildProfileExport(actor.profileId, actor.profile);
        })
      );
    }
    const account = await currentAccount(req);
    // The export is the owner's own copy: include the full email (decrypted). The phone number is only
    // stored as a one-way hash, so it cannot be exported.
    let email = '';
    try {
      email = user.emailEnc ? decryptEmail(user.emailEnc) : '';
    } catch {
      email = '';
    }
    return sendJson(res, 200, { ok: true, export: { account: { ...account, email }, profiles } });
  })
];

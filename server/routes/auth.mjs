// Account API: phone + password login. Disabled (404) while AUTH_MODE=access-code.
import { route } from '../http/router.mjs';
import { readJsonBody, sendJson } from '../http/response.mjs';
import { enforceRateLimit } from '../http/rate-limit.mjs';
import { AUTH_ENABLED, AUTH_MODE, AUTH_POW_DIFFICULTY, REGISTRATION_MODE } from '../config/index.mjs';
import { createHttpError } from '../lib/util.mjs';
import { issueChallenge } from '../accounts/pow.mjs';
import {
  accountProfileIds,
  changePassword,
  claimDeviceData,
  currentAccount,
  deleteAccount,
  loginAccount,
  logoutAccount,
  regenerateRecoveryCodes,
  registerAccount,
  requireAccount,
  resetPasswordWithRecovery
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
      registration: AUTH_ENABLED ? REGISTRATION_MODE : 'closed',
      humanCheckDifficulty: AUTH_POW_DIFFICULTY
    });
  }),
  route('GET', '/api/auth/me', async ({ req, res }) => {
    enforceRateLimit(req, 'public-read');
    return sendJson(res, 200, { ok: true, mode: AUTH_MODE, account: AUTH_ENABLED ? await currentAccount(req) : null });
  }),
  route('GET', '/api/auth/challenge', async ({ req, res, url }) => {
    requireEnabled();
    enforceRateLimit(req);
    const purpose = String(url.searchParams.get('purpose') ?? '');
    if (!['register', 'login', 'reset'].includes(purpose)) throw createHttpError('不支持的安全检查', 400, 'HUMAN_CHECK_PURPOSE_INVALID');
    return sendJson(res, 200, { ok: true, ...issueChallenge(purpose) });
  }),
  post('/api/auth/register', registerAccount),
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
    return sendJson(res, 200, { ok: true, export: { account, profiles } });
  })
];

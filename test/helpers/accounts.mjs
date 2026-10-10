import { fetchJson, jsonHeaders } from './server.mjs';
import { solveChallenge } from '../../server/accounts/pow.mjs';

export const PHONE_SECRET = 'unit-test-phone-hash-secret-0123456789abcdef';
export const INVITE = 'unit-test-invite-code';
export const authEnv = (mode = 'login', extra = {}) => ({
  AUTH_MODE: mode,
  AUTH_PHONE_HASH_SECRET: PHONE_SECRET,
  REGISTRATION_MODE: 'invite',
  REGISTRATION_INVITE_CODE: INVITE,
  AUTH_POW_DIFFICULTY: '4',
  AUTH_EMAIL_HASH_SECRET: 'unit-test-email-hash-secret-0123456789abcdef',
  AUTH_EMAIL_ENC_KEY: 'unit-test-email-enc-key-0123456789abcdef0123',
  // The phone-era tests register without codes; email flows set this to true with a file outbox.
  EMAIL_VERIFICATION_REQUIRED: 'false',
  MAIL_TRANSPORT: 'file',
  ...extra
});

/** Minimal cookie jar for one browser. */
export function createClient(baseUrl) {
  let cookie = '';
  const client = {
    get cookie() {
      return cookie;
    },
    set cookie(value) {
      cookie = value;
    },
    /** @param {string} path @param {{ method?: string, body?: any, headers?: Record<string, string> }} [options] */
    async request(path, { method = 'GET', body, headers = {} } = {}) {
      const result = await fetchJson(`${baseUrl}${path}`, {
        method,
        headers: jsonHeaders({ ...(cookie ? { cookie } : {}), ...headers }),
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      for (const line of result.response.headers.getSetCookie()) {
        const [pair] = line.split(';');
        const value = pair.slice(pair.indexOf('=') + 1);
        cookie = value ? pair : '';
      }
      return result;
    },
    async humanCheck(purpose) {
      const { data } = await client.request(`/api/auth/challenge?purpose=${purpose}`);
      return { challenge: data.challenge, nonce: solveChallenge(data.challenge, data.difficulty) };
    },
    async register(phone, password, extra = {}) {
      return client.request('/api/auth/register', {
        method: 'POST',
        body: {
          phone,
          email: `p${String(phone).replace(/\D/g, '').slice(-11)}@example.com`,
          password,
          inviteCode: INVITE,
          acceptPrivacy: true,
          humanCheck: await client.humanCheck('register'),
          ...extra
        }
      });
    },
    login(phone, password, extra = {}) {
      return client.request('/api/auth/login', { method: 'POST', body: { phone, password, ...extra } });
    },
    async post(path, body = {}) {
      return client.request(path, { method: 'POST', body });
    }
  };
  return client;
}

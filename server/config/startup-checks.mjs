// Pure startup safety evaluation so the policy can be unit tested without
// booting the HTTP server.

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', '[::1]']);

/** @param {string} host */
export function isLoopbackHost(host) {
  const value = String(host ?? '')
    .trim()
    .toLowerCase();
  return LOOPBACK_HOSTS.has(value) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value);
}

export const LEGACY_DEV_PROFILE_SECRET = 'trusted-routebook-local-profile-id-v1';

/**
 * Resolves the HMAC secret used for profile ids / profile token hashes.
 *
 * Backward compatibility: older deployments never set PROFILE_ID_SECRET and the
 * server silently reused ROUTEBOOK_ADMIN_TOKEN (then ROUTEBOOK_API_TOKEN). Stored
 * stable profile ids (u_<hmac>) and accessTokenHash values were derived from that
 * value, so the legacy fallback is kept (same bytes, same hashes) but reported
 * as deprecated. See README "PROFILE_ID_SECRET 迁移".
 * @param {{ profileIdSecret?: string, adminToken?: string, apiToken?: string, isProduction: boolean }} input
 * @returns {{ secret: string, source: 'explicit' | 'legacy-admin-token' | 'legacy-api-token' | 'dev-default' | 'missing' }}
 */
export function resolveProfileIdSecret({ profileIdSecret, adminToken, apiToken, isProduction }) {
  if (profileIdSecret) return { secret: profileIdSecret, source: 'explicit' };
  if (adminToken) return { secret: adminToken, source: 'legacy-admin-token' };
  if (apiToken) return { secret: apiToken, source: 'legacy-api-token' };
  if (!isProduction) return { secret: LEGACY_DEV_PROFILE_SECRET, source: 'dev-default' };
  return { secret: '', source: 'missing' };
}

/**
 * @param {{
 *   host: string,
 *   isProduction: boolean,
 *   allowLocalApiBypass: boolean,
 *   allowLocalAdminBypass: boolean,
 *   trustProxyHeaders: boolean,
 *   allowBypassOnPublicHost: boolean,
 *   profileSecretSource: string,
 *   publicBaseUrl?: string
 * }} input
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function evaluateStartupSafety(input) {
  const errors = [];
  const warnings = [];
  const bypasses = [input.allowLocalApiBypass ? 'ALLOW_LOCAL_API_BYPASS' : '', input.allowLocalAdminBypass ? 'ALLOW_LOCAL_ADMIN_BYPASS' : ''].filter(Boolean);
  const publicHost = !isLoopbackHost(input.host);

  if (bypasses.length && publicHost) {
    const message =
      `${bypasses.join(' + ')} active while HOST=${input.host} is not loopback. ` +
      'Any same-host reverse proxy forwards requests from 127.0.0.1, so every remote client would be treated as local' +
      (input.trustProxyHeaders ? ' when the proxy omits X-Forwarded-For.' : ' (TRUST_PROXY_HEADERS is not enabled).');
    if (input.isProduction && !input.allowBypassOnPublicHost) {
      errors.push(
        `${message} Refusing to start in production; unset the bypass flags, bind HOST=127.0.0.1, or set ALLOW_LOCAL_BYPASS_ON_PUBLIC_HOST=true if you really mean it.`
      );
    } else {
      warnings.push(`${message} Use HOST=127.0.0.1 or set ALLOW_LOCAL_API_BYPASS=false / ALLOW_LOCAL_ADMIN_BYPASS=false.`);
    }
  } else if (bypasses.length && input.isProduction) {
    warnings.push(`${bypasses.join(' + ')} enabled in production; only use this for a private local demo.`);
  }

  if (input.profileSecretSource === 'missing') {
    errors.push('PROFILE_ID_SECRET must be set in production, or provide ROUTEBOOK_ADMIN_TOKEN/ROUTEBOOK_API_TOKEN as a (deprecated) fallback secret.');
  } else if (input.profileSecretSource === 'legacy-admin-token' || input.profileSecretSource === 'legacy-api-token') {
    const fallbackName = input.profileSecretSource === 'legacy-admin-token' ? 'ROUTEBOOK_ADMIN_TOKEN' : 'ROUTEBOOK_API_TOKEN';
    warnings.push(
      `DEPRECATED: PROFILE_ID_SECRET is not set, so ${fallbackName} is reused as the profile HMAC secret. ` +
        `Set PROFILE_ID_SECRET to the current value of ${fallbackName} to keep existing profile ids/tokens valid, ` +
        'then you can rotate the token independently (README: PROFILE_ID_SECRET 迁移).'
    );
  } else if (input.profileSecretSource === 'dev-default' && publicHost) {
    warnings.push(
      'PROFILE_ID_SECRET is not set and the public development default is in use on a non-loopback HOST; profile tokens are forgeable. Set PROFILE_ID_SECRET.'
    );
  }

  if (input.isProduction && !input.publicBaseUrl) {
    warnings.push('PUBLIC_BASE_URL is not set; share pages fall back to the request Host header for og:image URLs.');
  }
  return { errors, warnings };
}

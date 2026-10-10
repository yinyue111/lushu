// Pure startup safety evaluation so the policy can be unit tested without
// booting the HTTP server.
import { existsSync } from 'node:fs';

/** RFC1918 IPv4 or IPv6 unique-local literal (hostnames never count: DNS could point anywhere). */
export function isPrivateIpLiteral(host) {
  const value = String(host ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    if ([a, b, c, d].some((part) => part > 255)) return false;
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return value.includes(':') && /^f[cd][0-9a-f]{0,2}:/.test(value);
}

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
 *   publicBaseUrl?: string,
 *   mapTileProviders?: Array<{ id: string, key?: string }>,
 *   allowOsmBasemapInProduction?: boolean,
 *   aiProviderRegion?: string,
 *   moderationProvider?: string,
 *   authEnabled?: boolean,
 *   authPhoneHashSecret?: string,
 *   registrationMode?: string,
 *   registrationInviteCode?: string,
 *   authEmailHashSecret?: string,
 *   authEmailEncKey?: string,
 *   emailVerificationRequired?: boolean,
 *   mailTransport?: string,
 *   mailTransportInvalid?: boolean,
 *   mailFrom?: string,
 *   mailApiKey?: string,
 *   smtp?: { host: string, port: number, secure: string, user: string, tlsVerify: boolean, caFile: string, allowPlaintextPrivate?: boolean }
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

  // Maps shown to the public in mainland China need a basemap with 审图号: 天地图 (key) or
  // 高德 (with its own key under its terms). OpenStreetMap is fine for development only.
  if (input.isProduction && Array.isArray(input.mapTileProviders)) {
    const unapproved = input.mapTileProviders
      .filter((provider) => !(provider.id === 'tianditu' && provider.key) && !(provider.id === 'amap' && provider.key))
      .map((provider) => provider.id);
    if (unapproved.length) {
      const message = `Basemap provider(s) ${unapproved.join(', ')} are not approved for production. Set TIANDITU_KEY (MAP_TILE_PROVIDERS=tianditu) or AMAP_TILE_KEY (MAP_TILE_PROVIDERS=amap).`;
      if (input.allowOsmBasemapInProduction) warnings.push(`${message} Allowed only because ALLOW_OSM_BASEMAP_IN_PRODUCTION=true.`);
      else errors.push(`${message} Refusing to start; ALLOW_OSM_BASEMAP_IN_PRODUCTION=true overrides this for non-public demos.`);
    }
  }

  // Compliance reminders (warnings only: the decisions belong to the operator, see
  // 合规决策清单 / docs/domestic-model-provider.md).
  if (input.isProduction && input.aiProviderRegion !== undefined && input.aiProviderRegion !== 'domestic') {
    warnings.push(
      `AI_PROVIDER_REGION=${input.aiProviderRegion || 'unset'}: serving the public in mainland China needs a filed (备案) domestic model or your own 生成式AI服务备案. Set AI_PROVIDER_REGION=domestic once the configured provider is one.`
    );
  }
  if (input.isProduction && input.moderationProvider !== undefined && input.moderationProvider !== 'domestic') {
    warnings.push(
      `MODERATION_PROVIDER=${input.moderationProvider}: public user content is only keyword pre-filtered; connect a domestic content-safety service before launch.`
    );
  }

  if (input.isProduction && !input.publicBaseUrl) {
    warnings.push('PUBLIC_BASE_URL is not set; share pages fall back to the request Host header for og:image URLs.');
  }
  if (input.authEnabled) {
    if (!input.authPhoneHashSecret) {
      errors.push(
        'AUTH_MODE enables accounts but AUTH_PHONE_HASH_SECRET is missing (>=32 random bytes; back it up: losing it makes every account unfindable).'
      );
    } else if (input.isProduction && String(input.authPhoneHashSecret).length < 32) {
      errors.push('AUTH_PHONE_HASH_SECRET must be at least 32 characters.');
    }
    if (input.authEmailHashSecret !== undefined) {
      if (!input.authEmailHashSecret)
        errors.push('AUTH_MODE enables accounts but AUTH_EMAIL_HASH_SECRET is missing (>=32 random bytes; back it up like AUTH_PHONE_HASH_SECRET).');
      else if (input.isProduction && String(input.authEmailHashSecret).length < 32) errors.push('AUTH_EMAIL_HASH_SECRET must be at least 32 characters.');
      if (!input.authEmailEncKey)
        errors.push('AUTH_MODE enables accounts but AUTH_EMAIL_ENC_KEY is missing (>=32 random bytes; losing it makes stored emails unreadable).');
      else if (input.isProduction && String(input.authEmailEncKey).length < 32) errors.push('AUTH_EMAIL_ENC_KEY must be at least 32 characters.');
      if (input.mailTransportInvalid) errors.push('MAIL_TRANSPORT must be one of file, log, resend, smtp, disabled.');
      if (input.mailTransport === 'smtp') {
        const smtp = input.smtp ?? { host: '', port: 0, secure: 'invalid', user: '', tlsVerify: true, caFile: '' };
        if (!smtp.host || !input.mailFrom) errors.push('MAIL_TRANSPORT=smtp needs MAIL_SMTP_HOST and MAIL_FROM.');
        if (smtp.secure === 'invalid') errors.push('MAIL_SMTP_SECURE must be one of starttls, tls, none.');
        const loopback = ['localhost', '127.0.0.1', '::1'].includes(smtp.host);
        if (smtp.secure === 'none' && !loopback) {
          if (!isPrivateIpLiteral(smtp.host)) {
            errors.push(
              'MAIL_SMTP_SECURE=none is only allowed for localhost or a private IP literal (10/8, 172.16/12, 192.168/16, fc00::/7, e.g. the Docker bridge gateway); use starttls or tls for any other mail server.'
            );
          } else if (!smtp.allowPlaintextPrivate) {
            errors.push(`MAIL_SMTP_SECURE=none to ${smtp.host} needs MAIL_SMTP_ALLOW_PLAINTEXT_PRIVATE=true (plain SMTP on a private network).`);
          } else {
            warnings.push(`Mail goes to ${smtp.host} over plain SMTP (private network relay, MAIL_SMTP_ALLOW_PLAINTEXT_PRIVATE=true).`);
          }
        }
        if (!smtp.tlsVerify) {
          if (input.isProduction) errors.push('MAIL_SMTP_TLS_VERIFY=false is not allowed in production; trust a private CA with MAIL_SMTP_CA_FILE instead.');
          else warnings.push('MAIL_SMTP_TLS_VERIFY=false: the mail server certificate is not checked.');
        }
        if (smtp.caFile && !existsSync(smtp.caFile)) errors.push('MAIL_SMTP_CA_FILE does not exist.');
      }
      if (input.mailTransport === 'resend' && (!input.mailApiKey || !input.mailFrom)) errors.push('MAIL_TRANSPORT=resend needs MAIL_API_KEY and MAIL_FROM.');
      const delivers = ['resend', 'smtp', 'file'].includes(String(input.mailTransport));
      if (input.emailVerificationRequired && !delivers) {
        const message = `EMAIL_VERIFICATION_REQUIRED=true but MAIL_TRANSPORT=${input.mailTransport} does not deliver mail: nobody can register or reset a password by email.`;
        if (input.isProduction) errors.push(`${message} Configure a mail provider or set EMAIL_VERIFICATION_REQUIRED=false for now.`);
        else warnings.push(message);
      }
      if (input.isProduction && input.mailTransport === 'file')
        warnings.push('MAIL_TRANSPORT=file in production writes mails to disk instead of sending them.');
    }
    if (input.isProduction && input.registrationMode === 'invite' && !input.registrationInviteCode) {
      warnings.push('REGISTRATION_MODE=invite without REGISTRATION_INVITE_CODE or ROUTEBOOK_API_TOKEN: nobody can register.');
    }
  }
  return { errors, warnings };
}

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
 *   publicBaseUrl?: string,
 *   mapTileProviders?: Array<{ id: string, key?: string }>,
 *   allowOsmBasemapInProduction?: boolean,
 *   aiProviderRegion?: string,
 *   moderationProvider?: string
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
  return { errors, warnings };
}

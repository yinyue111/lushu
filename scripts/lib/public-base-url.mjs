const DEFAULT_PUBLIC_BASE_URL = 'https://lushu.aiwuq.cn';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

function isLocalHostname(hostname) {
  const lower = String(hostname || '').toLowerCase();
  return LOCAL_HOSTS.has(lower) || lower.endsWith('.localhost');
}

/**
 * Resolves PUBLIC_BASE_URL for Vite index.html metadata.
 * Enforcement is gated strictly by REQUIRE_PUBLIC_BASE_URL=1 (never CI=true, so ci.yml and local verify keep working).
 * @param {Record<string, string | undefined>} [env]
 */
export function resolveBuildPublicBaseUrl(env = process.env) {
  const required = String(env?.REQUIRE_PUBLIC_BASE_URL ?? '').trim() === '1';
  const raw = String(env?.PUBLIC_BASE_URL ?? '').trim();
  if (!raw) {
    if (required) {
      throw new Error('REQUIRE_PUBLIC_BASE_URL=1 requires PUBLIC_BASE_URL to be set (e.g. https://lushu.aiwuq.cn).');
    }
    return DEFAULT_PUBLIC_BASE_URL;
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid PUBLIC_BASE_URL: ${raw}`);
  }
  if (required) {
    if (parsed.protocol !== 'https:') {
      throw new Error(`PUBLIC_BASE_URL must use https when REQUIRE_PUBLIC_BASE_URL=1 (got ${parsed.protocol}).`);
    }
    if (isLocalHostname(parsed.hostname)) {
      throw new Error(`PUBLIC_BASE_URL must not be localhost or loopback when REQUIRE_PUBLIC_BASE_URL=1 (got ${parsed.hostname}).`);
    }
  } else if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`PUBLIC_BASE_URL must use http or https (got ${parsed.protocol}).`);
  }
  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
}

/**
 * Vite plugin that injects absolute og:url, canonical and og:image into index.html at build/serve time.
 * @param {Record<string, string | undefined>} [env]
 */
export function publicBaseUrlHtmlPlugin(env = process.env) {
  let baseUrl = DEFAULT_PUBLIC_BASE_URL;
  return {
    name: 'lushu-public-base-url',
    configResolved() {
      baseUrl = resolveBuildPublicBaseUrl(env);
    },
    transformIndexHtml(html) {
      const homeUrl = `${baseUrl}/`;
      let next = html.replace(/(<meta\s+property="og:image"\s+content=")(\/[^"]*)(")/i, (_whole, pre, relPath, post) => `${pre}${baseUrl}${relPath}${post}`);
      if (!/property="og:url"/i.test(next)) {
        next = next.replace(
          /(<meta\s+property="og:site_name"[^>]*>)/i,
          `$1\n    <meta property="og:url" content="${homeUrl}" />\n    <link rel="canonical" href="${homeUrl}" />`
        );
      }
      return next;
    }
  };
}

// M5: minimal table-driven router.
//
// Patterns are matched segment by segment: a literal segment must match exactly,
// `:name` matches exactly one raw segment (it never spans '/'), and a
// trailing `*` matches the rest of the path. Before the split, prefix checks such
// as `pathname.startsWith('/api/routebooks/')` let `/api/routebooks/rb/-hz`
// resolve to the id `rb-hz` because sanitizePublicId strips the '/'.
// Params are returned raw (still percent-encoded); handlers decode them.

/**
 * @typedef {{ req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, url: URL, params: Record<string, string> }} RouteContext
 * @typedef {{ method: string, pattern: string, segments: string[], wildcard: boolean, poiCatalog: boolean, handler: (context: RouteContext) => unknown }} Route
 * @typedef {{ poiCatalog?: boolean }} RouteOptions
 */

/** Route option for handlers that never resolve POIs (see route()). */
export const NO_POI_CATALOG = Object.freeze({ poiCatalog: false });

/**
 * @param {string} method
 * @param {string} pattern
 * @param {(context: RouteContext) => unknown} handler
 * @param {RouteOptions} [options] `poiCatalog: false` marks a route whose handler
 *   never resolves POIs, so the API entry skips the catalog freshness check.
 *   Routes default to `true` (fail-safe: an unmarked route always sees a fresh catalog).
 * @returns {Route}
 */
export function route(method, pattern, handler, options = {}) {
  if (!pattern.startsWith('/')) throw new Error(`Route pattern must start with '/': ${pattern}`);
  const segments = pattern.slice(1).split('/');
  const wildcard = segments.at(-1) === '*';
  if (wildcard) segments.pop();
  if (segments.slice(0, -1).includes('*') || segments.includes('*')) throw new Error(`'*' is only allowed as the last segment: ${pattern}`);
  return { method: method.toUpperCase(), pattern, segments, wildcard, poiCatalog: options.poiCatalog !== false, handler };
}

/**
 * @param {Route} candidate
 * @param {string[]} parts
 * @returns {Record<string, string> | null}
 */
function matchSegments(candidate, parts) {
  const { segments, wildcard } = candidate;
  if (wildcard ? parts.length <= segments.length : parts.length !== segments.length) return null;
  /** @type {Record<string, string>} */
  const params = {};
  for (let index = 0; index < segments.length; index += 1) {
    const expected = segments[index];
    const actual = parts[index];
    if (expected.startsWith(':')) {
      // An empty segment (`/api/routebooks/`) still matches so handlers keep
      // returning their own 400/404 for a missing id.
      params[expected.slice(1)] = actual;
    } else if (expected !== actual) {
      return null;
    }
  }
  if (wildcard) params['*'] = parts.slice(segments.length).join('/');
  return params;
}

/** @param {Route[]} routes */
export function createRouter(routes) {
  return {
    routes,
    /**
     * First matching route wins (table order), like the old if-chain.
     * @param {string | undefined} method
     * @param {string} pathname
     */
    match(method, pathname) {
      const upper = String(method ?? '').toUpperCase();
      const parts = String(pathname ?? '')
        .slice(1)
        .split('/');
      for (const candidate of routes) {
        if (candidate.method !== upper) continue;
        const params = matchSegments(candidate, parts);
        if (params) return { route: candidate, params };
      }
      return null;
    }
  };
}

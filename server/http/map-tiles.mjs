// Map tile proxy with an in-memory LRU cache, provider fallback and
// placeholder-tile detection (see map-providers.mjs).
import { createHash } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import {
  MAP_TILE_CACHE_MAX_ENTRIES,
  MAP_TILE_MAX_BYTES,
  MAP_TILE_PROVIDER_COOLDOWN_MS,
  MAP_TILE_UPSTREAM_TIMEOUT_MS,
  MAP_TILE_TIMEOUT_MS,
  MAP_TILE_UPSTREAMS
} from '../config/index.mjs';
import { describeMapTileProviders, isPlaceholderTile, looksLikeImage } from './map-providers.mjs';
import { requestIdHeaders, securityHeaders, sendJson } from './response.mjs';
import { createHttpError } from '../lib/util.mjs';

const mapTileCache = new Map();
// Per provider+layer: hash of the 0/0/0 world tile, used to spot placeholders.
const referenceHashes = new Map();
// Per provider: timestamp until which it is skipped after serving placeholders.
const providerCooldowns = new Map();
const REFERENCE_TTL_MS = 6 * 60 * 60 * 1000;

function parseMapTilePath(pathname) {
  const match = String(pathname ?? '').match(/^\/api\/map-tiles\/(?:(labels)\/)?(\d{1,2})\/(\d{1,10})\/(\d{1,10})\.png$/);
  if (!match) return null;
  const [, labels, zText, xText, yText] = match;
  const z = Number(zText);
  const x = Number(xText);
  const y = Number(yText);
  if (!Number.isInteger(z) || z < 0 || z > 19) return null;
  const maxIndex = 2 ** z - 1;
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x > maxIndex || y > maxIndex) return null;
  return { z, x, y, key: `${z}/${x}/${y}`, layer: labels ? 'labels' : 'base' };
}

function readCachedMapTile(key) {
  const cached = mapTileCache.get(key);
  if (!cached) return null;
  mapTileCache.delete(key);
  mapTileCache.set(key, cached);
  return cached;
}

function cacheMapTile(key, tile) {
  mapTileCache.delete(key);
  mapTileCache.set(key, tile);
  while (mapTileCache.size > MAP_TILE_CACHE_MAX_ENTRIES) {
    mapTileCache.delete(mapTileCache.keys().next().value);
  }
}

function sendMapTile(res, tile, cacheState) {
  res.writeHead(200, {
    ...securityHeaders(),
    ...requestIdHeaders(res),
    'content-type': tile.contentType,
    'content-length': tile.body.length,
    'cache-control': 'public, max-age=86400, stale-while-revalidate=604800',
    'x-map-tile-cache': cacheState,
    'x-map-tile-source': tile.source
  });
  res.end(tile.body);
}

function sha256(body) {
  return createHash('sha256').update(body).digest('hex');
}

function requestMapTileUpstream(upstream, tileRequest, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let total = 0;
    const request = httpsRequest(
      {
        protocol: 'https:',
        hostname: upstream.hostname(tileRequest),
        port: 443,
        method: 'GET',
        path: upstream.path(tileRequest, tileRequest.layer, upstream.key),
        signal,
        headers: {
          accept: 'image/png,image/*;q=0.8,*/*;q=0.5',
          'user-agent': 'TrustedRoutebook/0.1 (+local map tile proxy)'
        }
      },
      (response) => {
        const statusCode = response.statusCode ?? 0;
        const declaredLength = Number(response.headers['content-length'] ?? 0);
        if (statusCode < 200 || statusCode >= 300) {
          response.resume();
          rejectPromise(createHttpError(`地图上游返回 HTTP ${statusCode}`, 502, 'MAP_TILE_UPSTREAM_ERROR'));
          return;
        }
        if (declaredLength > MAP_TILE_MAX_BYTES) {
          response.destroy();
          rejectPromise(createHttpError('地图瓦片响应过大', 502, 'MAP_TILE_TOO_LARGE'));
          return;
        }
        response.on('data', (chunk) => {
          total += chunk.length;
          if (total > MAP_TILE_MAX_BYTES) {
            response.destroy(createHttpError('地图瓦片响应过大', 502, 'MAP_TILE_TOO_LARGE'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          const body = Buffer.concat(chunks);
          const upstreamType = String(response.headers['content-type'] ?? '');
          // HTML/XML error pages (bad key, quota) are often sent with HTTP 200.
          if (!body.length || (upstreamType && !upstreamType.startsWith('image/')) || !looksLikeImage(body)) {
            rejectPromise(createHttpError('地图瓦片内容无效', 502, 'MAP_TILE_INVALID'));
            return;
          }
          resolvePromise({
            body,
            contentType: upstreamType.startsWith('image/') ? upstreamType : 'image/png',
            source: upstream.id
          });
        });
        response.on('error', rejectPromise);
      }
    );
    request.setTimeout(MAP_TILE_UPSTREAM_TIMEOUT_MS, () => {
      request.destroy(createHttpError('地图上游连接超时', 504, 'MAP_TILE_UPSTREAM_TIMEOUT'));
    });
    request.on('error', rejectPromise);
    request.end();
  });
}

async function referenceHashFor(upstream, layer, signal) {
  const cacheKey = `${upstream.id}:${layer}`;
  const known = referenceHashes.get(cacheKey);
  if (known && Date.now() - known.at < REFERENCE_TTL_MS) return known.hash;
  try {
    const world = await requestMapTileUpstream(upstream, { z: 0, x: 0, y: 0, key: '0/0/0', layer }, signal);
    const hash = sha256(world.body);
    referenceHashes.set(cacheKey, { hash, at: Date.now() });
    return hash;
  } catch {
    // Without a reference we can still rely on the known-placeholder list.
    return null;
  }
}

async function fetchVerifiedTile(upstream, tileRequest, signal) {
  const tile = await requestMapTileUpstream(upstream, tileRequest, signal);
  const hash = sha256(tile.body);
  const referenceHash = tileRequest.z >= 3 ? await referenceHashFor(upstream, tileRequest.layer, signal) : null;
  if (isPlaceholderTile({ hash, z: tileRequest.z, referenceHash })) {
    providerCooldowns.set(upstream.id, Date.now() + MAP_TILE_PROVIDER_COOLDOWN_MS);
    throw createHttpError('地图上游返回了占位图', 502, 'MAP_TILE_PLACEHOLDER');
  }
  return tile;
}

const RETRYABLE_NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNABORTED', 'UND_ERR_SOCKET']);

// Raw socket errors from the upstream (e.g. a CDN edge resetting the
// connection) carry no HTTP status and used to surface as a generic 500.
// Map them to a 502 with a stable code; the message never includes the
// upstream URL, so a tile key in the query string cannot leak.
export function normalizeTileUpstreamError(error) {
  if (error && Number.isInteger(error.statusCode)) return error;
  const networkCode = typeof error?.code === 'string' ? error.code : 'unknown';
  const normalized = createHttpError('地图上游连接中断', 502, 'MAP_TILE_UPSTREAM_NETWORK');
  normalized.upstreamCode = networkCode;
  return normalized;
}

function isRetryableTileError(error) {
  if (!error || Number.isInteger(error.statusCode)) return false;
  return RETRYABLE_NETWORK_CODES.has(error.code) || /socket hang up/i.test(String(error.message ?? ''));
}

// One immediate retry for a transient network error (single-provider setups
// such as amap-only have no fallback provider to absorb a reset).
export async function fetchTileWithRetry(fetchTile, upstream, tileRequest, signal) {
  try {
    return await fetchTile(upstream, tileRequest, signal);
  } catch (error) {
    if (signal?.aborted || !isRetryableTileError(error)) throw normalizeTileUpstreamError(error);
    try {
      return await fetchTile(upstream, tileRequest, signal);
    } catch (retryError) {
      if (signal?.aborted) throw retryError;
      throw normalizeTileUpstreamError(retryError);
    }
  }
}

function sendMapTileConfig(res) {
  return sendJson(res, 200, describeMapTileProviders(MAP_TILE_UPSTREAMS));
}

export async function handleMapTile(req, res, url) {
  if (url.pathname === '/api/map-tiles/config') return sendMapTileConfig(res);
  const tileRequest = parseMapTilePath(url.pathname);
  if (!tileRequest) throw createHttpError('地图瓦片路径不合法', 400, 'INVALID_MAP_TILE');
  const upstreams = MAP_TILE_UPSTREAMS.filter((upstream) => tileRequest.layer === 'base' || upstream.hasLabels);
  if (!upstreams.length) throw createHttpError('当前底图没有独立注记图层', 404, 'MAP_TILE_NO_LABELS');
  const cacheKey = `${tileRequest.layer}:${tileRequest.key}`;

  const cached = readCachedMapTile(cacheKey);
  if (cached) return sendMapTile(res, cached, 'HIT');

  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, MAP_TILE_TIMEOUT_MS);
  req.once('aborted', () => controller.abort());
  try {
    let tile = null;
    let lastError = null;
    const now = Date.now();
    const available = upstreams.filter((upstream) => (providerCooldowns.get(upstream.id) ?? 0) <= now);
    for (const upstream of available.length ? available : upstreams) {
      try {
        tile = await fetchTileWithRetry(fetchVerifiedTile, upstream, tileRequest, controller.signal);
        break;
      } catch (error) {
        if (controller.signal.aborted) throw error;
        lastError = error;
      }
    }
    if (!tile) throw lastError || createHttpError('地图底图暂时不可用', 502, 'MAP_TILE_UNAVAILABLE');
    cacheMapTile(cacheKey, tile);
    return sendMapTile(res, tile, 'MISS');
  } catch (error) {
    if (req.aborted || res.destroyed) return undefined;
    if (error.name === 'AbortError' && timedOut) throw createHttpError('地图底图请求超时', 504, 'MAP_TILE_TIMEOUT');
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Map tile proxy with an in-memory LRU cache.
import { request as httpsRequest } from 'node:https';
import { MAP_TILE_CACHE_MAX_ENTRIES, MAP_TILE_MAX_BYTES, MAP_TILE_UPSTREAM_TIMEOUT_MS, MAP_TILE_TIMEOUT_MS, MAP_TILE_UPSTREAMS } from '../config/index.mjs';
import { requestIdHeaders, securityHeaders } from './response.mjs';
import { createHttpError } from '../lib/util.mjs';

export const mapTileCache = new Map();

export function parseMapTilePath(pathname) {
  const match = String(pathname ?? '').match(/^\/api\/map-tiles\/(\d{1,2})\/(\d{1,10})\/(\d{1,10})\.png$/);
  if (!match) return null;
  const [, zText, xText, yText] = match;
  const z = Number(zText);
  const x = Number(xText);
  const y = Number(yText);
  if (!Number.isInteger(z) || z < 0 || z > 19) return null;
  const maxIndex = (2 ** z) - 1;
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x > maxIndex || y > maxIndex) return null;
  return { z, x, y, key: `${z}/${x}/${y}` };
}

export function readCachedMapTile(key) {
  const cached = mapTileCache.get(key);
  if (!cached) return null;
  mapTileCache.delete(key);
  mapTileCache.set(key, cached);
  return cached;
}

export function cacheMapTile(key, tile) {
  mapTileCache.delete(key);
  mapTileCache.set(key, tile);
  while (mapTileCache.size > MAP_TILE_CACHE_MAX_ENTRIES) {
    mapTileCache.delete(mapTileCache.keys().next().value);
  }
}

export function sendMapTile(res, tile, cacheState) {
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

export function requestMapTileUpstream(upstream, tileRequest, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let total = 0;
    const request = httpsRequest({
      protocol: 'https:',
      hostname: upstream.hostname,
      port: 443,
      method: 'GET',
      path: upstream.path(tileRequest.key),
      signal,
      headers: {
        accept: 'image/png,image/*;q=0.8,*/*;q=0.5',
        'user-agent': 'TrustedRoutebook/0.1 (+local map tile proxy)'
      }
    }, (response) => {
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
        if (!body.length) {
          rejectPromise(createHttpError('地图瓦片内容无效', 502, 'MAP_TILE_INVALID'));
          return;
        }
        const upstreamType = String(response.headers['content-type'] ?? '');
        resolvePromise({
          body,
          contentType: upstreamType.startsWith('image/') ? upstreamType : 'image/png',
          source: upstream.id
        });
      });
      response.on('error', rejectPromise);
    });
    request.setTimeout(MAP_TILE_UPSTREAM_TIMEOUT_MS, () => {
      request.destroy(createHttpError('地图上游连接超时', 504, 'MAP_TILE_UPSTREAM_TIMEOUT'));
    });
    request.on('error', rejectPromise);
    request.end();
  });
}

export async function handleMapTile(req, res, url) {
  const tileRequest = parseMapTilePath(url.pathname);
  if (!tileRequest) throw createHttpError('地图瓦片路径不合法', 400, 'INVALID_MAP_TILE');

  const cached = readCachedMapTile(tileRequest.key);
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
    for (const upstream of MAP_TILE_UPSTREAMS) {
      try {
        tile = await requestMapTileUpstream(upstream, tileRequest, controller.signal);
        break;
      } catch (error) {
        if (controller.signal.aborted) throw error;
        lastError = error;
      }
    }
    if (!tile) throw lastError || createHttpError('地图底图暂时不可用', 502, 'MAP_TILE_UNAVAILABLE');
    cacheMapTile(tileRequest.key, tile);
    return sendMapTile(res, tile, 'MISS');
  } catch (error) {
    if (req.aborted || res.destroyed) return undefined;
    if (error.name === 'AbortError' && timedOut) throw createHttpError('地图底图请求超时', 504, 'MAP_TILE_TIMEOUT');
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

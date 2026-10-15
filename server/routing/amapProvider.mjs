import { coordinateForAmap, gcj02ToWgs84, isValidCoordinate } from './coordinates.mjs';
import { ROUTING_ERROR_CODES, RoutingError } from './errors.mjs';
import { ROUTING_MODES, normalizeLegGeometry } from './routeLegs.mjs';

const DEFAULT_AMAP_BASE_URL = 'https://restapi.amap.com';
const MODE_PATHS = Object.freeze({
  walking: '/v3/direction/walking',
  driving: '/v3/direction/driving',
  transit: '/v3/direction/transit/integrated',
  bicycling: '/v4/direction/bicycling'
});

export function createAmapRoutingProvider({ apiKey = '', fetchImpl = globalThis.fetch, timeoutMs = 5000, baseUrl = DEFAULT_AMAP_BASE_URL } = {}) {
  const key = String(apiKey || '').trim();
  const requestTimeoutMs = clampTimeout(timeoutMs);
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);

  const provider = Object.freeze({
    id: 'amap',
    configured: Boolean(key) && typeof fetchImpl === 'function',
    supportsMode: (mode) => ROUTING_MODES.includes(String(mode || '').toLowerCase()),
    /** @param {Record<string, any>} [options] */
    async route({ origin, destination, mode = 'walking', city = '', signal } = {}) {
      if (!key) {
        throw new RoutingError(ROUTING_ERROR_CODES.PROVIDER_NOT_CONFIGURED, '未配置高德 Web 服务密钥，道路路线还没核对', {
          category: 'configuration',
          retryable: false
        });
      }
      if (typeof fetchImpl !== 'function') {
        throw new RoutingError(ROUTING_ERROR_CODES.FETCH_UNAVAILABLE, '当前运行时无法请求高德路径规划服务', { category: 'configuration', retryable: false });
      }

      const normalizedMode = String(mode || '')
        .trim()
        .toLowerCase();
      if (!ROUTING_MODES.includes(normalizedMode)) {
        throw new RoutingError(ROUTING_ERROR_CODES.MODE_UNSUPPORTED, `高德路径规划不支持模式：${normalizedMode.slice(0, 24) || '空'}`, {
          category: 'input',
          retryable: false
        });
      }
      if (normalizedMode === 'transit' && !String(city || '').trim()) {
        throw new RoutingError(ROUTING_ERROR_CODES.CITY_REQUIRED, '公交/地铁路径规划需要目的地城市', { category: 'input', retryable: false });
      }

      const amapOrigin = coordinateForAmap(origin);
      const amapDestination = coordinateForAmap(destination);
      if (!amapOrigin || !amapDestination) {
        throw new RoutingError(ROUTING_ERROR_CODES.COORDINATES_MISSING, '路段起终点缺少可用坐标，道路路线还没核对', { category: 'input', retryable: false });
      }

      const url = buildAmapUrl({
        baseUrl: normalizedBaseUrl,
        key,
        mode: normalizedMode,
        city,
        origin: amapOrigin,
        destination: amapDestination
      });
      const request = requestSignalWithTimeout(signal, requestTimeoutMs);
      let response;
      let data;
      try {
        response = await fetchImpl(url, {
          method: 'GET',
          headers: { accept: 'application/json' },
          signal: request.signal
        });
        request.throwIfAborted();
        if (!response?.ok) {
          const status = Number(response?.status) || 502;
          throw new RoutingError(ROUTING_ERROR_CODES.UPSTREAM_HTTP_ERROR, `高德路径规划返回 HTTP ${status}`, {
            category: 'upstream',
            retryable: status === 408 || status === 429 || status >= 500,
            httpStatus: status
          });
        }
        try {
          data = await response.json();
        } catch (error) {
          request.rethrowAbort(error);
          throw new RoutingError(ROUTING_ERROR_CODES.UPSTREAM_PAYLOAD_INVALID, '高德路径规划返回了无法解析的数据', {
            category: 'upstream_payload',
            retryable: true,
            cause: error
          });
        }
        request.throwIfAborted();
      } catch (error) {
        if (error instanceof RoutingError) throw error;
        request.rethrowAbort(error);
        throw new RoutingError(ROUTING_ERROR_CODES.NETWORK_ERROR, '无法连接高德路径规划服务', { category: 'network', retryable: true, cause: error });
      } finally {
        request.cleanup();
      }

      assertAmapAccepted(data);
      // 两站很近时高德公交规划不给换乘方案（transits 为空），实际就是步行：按步行核验道路，
      // 路段仍记为用户选择的公共交通方式，并标记 walkingOnly 供界面说明“无需乘车”。
      if (normalizedMode === 'transit' && isWalkOnlyTransit(data)) {
        const walking = await provider.route({ origin, destination, mode: 'walking', city, signal });
        return { ...walking, mode: 'transit', walkingOnly: true };
      }
      const path = selectAmapPath(data, normalizedMode);
      if (!path) {
        throw new RoutingError(ROUTING_ERROR_CODES.ROUTE_NOT_FOUND, '高德未返回可用的道路路线', { category: 'upstream', retryable: false });
      }

      const distanceMeters = parseNonNegativeNumber(path.distance);
      const durationSeconds = parseNonNegativeNumber(path.duration);
      const geometry = amapPathGeometry(path);
      if (distanceMeters == null || durationSeconds == null || geometry.length < 2) {
        throw new RoutingError(ROUTING_ERROR_CODES.UPSTREAM_PAYLOAD_INVALID, '高德路径规划结果缺少完整距离、时长或道路折线', {
          category: 'upstream_payload',
          retryable: true
        });
      }

      return {
        status: 'verified',
        provider: 'amap',
        mode: normalizedMode,
        distanceMeters,
        durationSeconds,
        geometry
      };
    }
  });
  return provider;
}

function buildAmapUrl({ baseUrl, key, mode, city, origin, destination }) {
  const url = new URL(MODE_PATHS[mode], `${baseUrl}/`);
  url.searchParams.set('key', key);
  url.searchParams.set('origin', `${formatCoordinate(origin.lng)},${formatCoordinate(origin.lat)}`);
  url.searchParams.set('destination', `${formatCoordinate(destination.lng)},${formatCoordinate(destination.lat)}`);
  if (mode === 'transit') url.searchParams.set('city', String(city).trim());
  if (mode === 'driving') url.searchParams.set('extensions', 'base');
  return url;
}

function assertAmapAccepted(data) {
  const v3Rejected = data?.status != null && String(data.status) !== '1';
  const v4Rejected = data?.errcode != null && Number(data.errcode) !== 0;
  if (!v3Rejected && !v4Rejected) return;
  const upstreamCode = String(data?.infocode ?? data?.errcode ?? '').slice(0, 40);
  const upstreamMessage = String(data?.info ?? data?.errmsg ?? '上游拒绝请求').slice(0, 100);
  const retryable = ['10004', '10016', '10020', '10021', '10044'].includes(upstreamCode);
  throw new RoutingError(ROUTING_ERROR_CODES.UPSTREAM_REJECTED, `高德路径规划未通过：${upstreamMessage}`, { category: 'upstream', retryable, upstreamCode });
}

const WALK_ONLY_TRANSIT_MAX_METERS = 1500;

function isWalkOnlyTransit(data) {
  const transits = data?.route?.transits;
  const walkingDistance = Number(data?.route?.distance);
  return (
    (!Array.isArray(transits) || transits.length === 0) &&
    Number.isFinite(walkingDistance) &&
    walkingDistance > 0 &&
    walkingDistance <= WALK_ONLY_TRANSIT_MAX_METERS
  );
}

function selectAmapPath(data, mode) {
  if (mode === 'transit') return Array.isArray(data?.route?.transits) ? data.route.transits[0] : null;
  if (Array.isArray(data?.route?.paths)) return data.route.paths[0];
  if (Array.isArray(data?.data?.paths)) return data.data.paths[0];
  return null;
}

function amapPathGeometry(path) {
  const direct = parseAmapPolyline(path?.polyline);
  if (direct.length >= 2) return normalizeLegGeometry(direct);
  const polylines = [];
  collectPolylineStrings(path, polylines);
  const points = polylines.flatMap(parseAmapPolyline);
  return normalizeLegGeometry(points);
}

function collectPolylineStrings(value, output) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectPolylineStrings(item, output));
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (typeof value.polyline === 'string' && value.polyline.trim()) output.push(value.polyline);
  for (const [key, child] of Object.entries(value)) {
    if (key === 'polyline') continue;
    collectPolylineStrings(child, output);
  }
}

function parseAmapPolyline(value) {
  if (typeof value !== 'string') return [];
  return value
    .split(';')
    .map((entry) => {
      const [rawLng, rawLat] = entry.split(',');
      if (!rawLng?.trim() || !rawLat?.trim()) return null;
      const lng = Number(rawLng);
      const lat = Number(rawLat);
      if (!isValidCoordinate(lat, lng)) return null;
      const wgs84 = gcj02ToWgs84(lat, lng);
      return [wgs84.lat, wgs84.lng];
    })
    .filter(Boolean);
}

function requestSignalWithTimeout(parentSignal, timeoutMs) {
  const controller = new AbortController();
  let abortSource = '';
  const abortFromCaller = () => {
    if (!abortSource) abortSource = 'caller';
    controller.abort(parentSignal?.reason);
  };
  if (parentSignal?.aborted) abortFromCaller();
  else parentSignal?.addEventListener('abort', abortFromCaller, { once: true });
  const timeoutId = setTimeout(() => {
    if (!abortSource) abortSource = 'timeout';
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    throwIfAborted() {
      if (!controller.signal.aborted) return;
      this.rethrowAbort();
    },
    rethrowAbort(error) {
      if (abortSource === 'timeout') {
        throw new RoutingError(ROUTING_ERROR_CODES.TIMEOUT, `高德路径规划超过 ${timeoutMs}ms 未响应`, { category: 'timeout', retryable: true, cause: error });
      }
      if (abortSource === 'caller' || parentSignal?.aborted) {
        throw new RoutingError(ROUTING_ERROR_CODES.CANCELLED, '路径规划已取消', { category: 'cancelled', retryable: false, cause: error });
      }
      if (error?.name === 'AbortError') {
        throw new RoutingError(ROUTING_ERROR_CODES.NETWORK_ERROR, '高德路径规划连接被上游中断', { category: 'network', retryable: true, cause: error });
      }
    },
    cleanup() {
      clearTimeout(timeoutId);
      parentSignal?.removeEventListener('abort', abortFromCaller);
    }
  };
}

function parseNonNegativeNumber(value) {
  if (value == null || (typeof value === 'string' && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function formatCoordinate(value) {
  return Number(value).toFixed(6);
}

function clampTimeout(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 5000;
  return Math.max(1, Math.min(60000, Math.round(parsed)));
}

function normalizeBaseUrl(value) {
  const url = new URL(String(value || DEFAULT_AMAP_BASE_URL));
  if (!['http:', 'https:'].includes(url.protocol)) throw new TypeError('高德路径规划 baseUrl 必须使用 HTTP(S)');
  return url.toString().replace(/\/$/, '');
}

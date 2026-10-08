// AMap geocoding with an in-memory cache.
import { isValidCoordinate, truncateString } from '../lib/util.mjs';
import { AMAP_GEOCODE_KEY, GEOCODE_TIMEOUT_MS } from '../config/index.mjs';
import { coordinateDistanceWarning, gcj02ToWgs84 } from './coordinates.mjs';

const geocodeCache = new Map();

export async function geocodePoiWithAmap(city, name, signal) {
  const cacheKey = `${city}:${name}`;
  if (geocodeCache.has(cacheKey)) return geocodeCache.get(cacheKey);
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, GEOCODE_TIMEOUT_MS);
  const abortFromCaller = () => controller.abort();
  signal?.addEventListener('abort', abortFromCaller, { once: true });
  try {
    const params = new URLSearchParams({
      key: AMAP_GEOCODE_KEY,
      address: `${city}${name}`,
      city
    });
    const response = await fetch(`https://restapi.amap.com/v3/geocode/geo?${params}`, { signal: controller.signal });
    if (!response.ok) return null;
    const data = await response.json();
    const result = Array.isArray(data?.geocodes) ? data.geocodes[0] : null;
    const [gcjLng, gcjLat] = String(result?.location ?? '').split(',').map(Number);
    if (!isValidCoordinate(gcjLat, gcjLng)) return null;
    const wgs = gcj02ToWgs84(gcjLat, gcjLng);
    if (coordinateDistanceWarning(wgs.lat, wgs.lng, city)) return null;
    const level = truncateString(result?.level, 24) || 'unknown';
    const precise = /兴趣点|门牌号|道路/.test(level);
    const normalized = {
      lat: Number(wgs.lat.toFixed(6)),
      lng: Number(wgs.lng.toFixed(6)),
      geoConfidence: precise ? 92 : 55,
      coordinateSystem: 'WGS84',
      coordinateSource: 'amap-geocode',
      coordinatePrecision: level,
      coordinateRadiusMeters: precise ? 0 : 1500,
      navigationDisabled: !precise
    };
    geocodeCache.set(cacheKey, normalized);
    if (geocodeCache.size > 1000) geocodeCache.delete(geocodeCache.keys().next().value);
    return normalized;
  } catch (error) {
    if (signal?.aborted && !timedOut) throw error;
    return null;
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', abortFromCaller);
  }
}

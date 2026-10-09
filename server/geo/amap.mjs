// AMap geocoding: POI keyword search with a deterministic candidate chooser, falling back
// to address geocoding. Results are cached in memory per city+name.
import { isValidCoordinate, truncateString } from '../lib/util.mjs';
import { AMAP_API_BASE_URL, AMAP_GEOCODE_KEY, GEOCODE_TIMEOUT_MS } from '../config/index.mjs';
import { coordinateDistanceWarning, gcj02ToWgs84 } from './coordinates.mjs';
import { GEOCODE_PRECISION, chooseGeocodeCandidate, precisionFromAmapLevel } from './geocodeChooser.mjs';

const geocodeCache = new Map();
const MAX_CANDIDATES = 10;

const PRECISION_CONFIDENCE = Object.freeze({
  [GEOCODE_PRECISION.POI_EXACT]: 92,
  [GEOCODE_PRECISION.POI_NAME_MATCH]: 80,
  [GEOCODE_PRECISION.ADDRESS]: 75,
  [GEOCODE_PRECISION.ROAD]: 65,
  [GEOCODE_PRECISION.APPROXIMATE]: 55
});

export function clearGeocodeCache() {
  geocodeCache.clear();
}

function parseAmapLocation(location) {
  const [gcjLng, gcjLat] = String(location ?? '')
    .split(',')
    .map(Number);
  if (!isValidCoordinate(gcjLat, gcjLng)) return null;
  const wgs = gcj02ToWgs84(gcjLat, gcjLng);
  return { lat: Number(wgs.lat.toFixed(6)), lng: Number(wgs.lng.toFixed(6)) };
}

/** @param {string} path @param {Record<string, string>} params @param {any} [options] */
async function fetchAmapJson(path, params, options = {}) {
  const { signal, fetchImpl = globalThis.fetch, baseUrl = AMAP_API_BASE_URL } = options;
  const response = await fetchImpl(`${String(baseUrl).replace(/\/+$/, '')}${path}?${new URLSearchParams(params)}`, { signal });
  if (!response.ok) return null;
  const data = await response.json();
  // AMap reports errors with HTTP 200 and status "0".
  if (data && String(data.status ?? '1') === '0') return null;
  return data;
}

/** POI keyword search, limited to the city. Candidates outside the city are dropped. */
/** @param {string} city @param {string} name @param {any} [options] */
export async function searchAmapPoiCandidates(city, name, options = {}) {
  const data = await fetchAmapJson(
    '/v3/place/text',
    { key: options.apiKey ?? AMAP_GEOCODE_KEY, keywords: name, city, citylimit: 'true', offset: String(MAX_CANDIDATES), page: '1', extensions: 'base' },
    options
  );
  const pois = Array.isArray(data?.pois) ? data.pois.slice(0, MAX_CANDIDATES) : [];
  return pois.flatMap((poi, rank) => {
    const coordinate = parseAmapLocation(poi?.location);
    if (!coordinate || coordinateDistanceWarning(coordinate.lat, coordinate.lng, city)) return [];
    return [
      {
        id: truncateString(poi?.id, 40),
        name: truncateString(poi?.name, 80),
        address: truncateString(typeof poi?.address === 'string' ? poi.address : '', 120),
        typecode: truncateString(poi?.typecode, 24),
        rank,
        ...coordinate
      }
    ];
  });
}

async function geocodeAddressWithAmap(city, name, options) {
  const data = await fetchAmapJson('/v3/geocode/geo', { key: options.apiKey ?? AMAP_GEOCODE_KEY, address: `${city}${name}`, city }, options);
  const result = Array.isArray(data?.geocodes) ? data.geocodes[0] : null;
  const coordinate = parseAmapLocation(result?.location);
  if (!coordinate || coordinateDistanceWarning(coordinate.lat, coordinate.lng, city)) return null;
  const level = truncateString(result?.level, 24) || 'unknown';
  return { coordinate, level, precision: precisionFromAmapLevel(level) };
}

function geocodedStopFields(coordinate, source, precision, choice) {
  const navigable = precision !== GEOCODE_PRECISION.APPROXIMATE;
  return {
    lat: coordinate.lat,
    lng: coordinate.lng,
    geoConfidence: PRECISION_CONFIDENCE[precision] ?? 55,
    coordinateSystem: 'WGS84',
    coordinateSource: source,
    coordinatePrecision: precision,
    coordinateRadiusMeters: navigable ? 0 : 1500,
    navigationDisabled: !navigable,
    geocodeChoice: choice
  };
}

/**
 * Resolves a stop name to coordinates.
 * 1. POI search (`/v3/place/text`) → deterministic chooser (exact / alias / containment).
 * 2. No acceptable candidate → address geocode (`/v3/geocode/geo`), precision from `level`.
 * Returns null when neither yields an in-city coordinate. `options.onCandidates` receives
 * the candidate list and the choice (used by the shadow-evaluation hook; it must not throw
 * or alter the result).
 * @param {string} city @param {string} name @param {AbortSignal} [signal] @param {any} [options]
 */
export async function geocodePoiWithAmap(city, name, signal, options = {}) {
  const cacheKey = `${city}:${name}`;
  if (geocodeCache.has(cacheKey)) return geocodeCache.get(cacheKey);
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? GEOCODE_TIMEOUT_MS);
  const abortFromCaller = () => controller.abort();
  signal?.addEventListener('abort', abortFromCaller, { once: true });
  const requestOptions = { ...options, signal: controller.signal };
  try {
    let normalized = null;
    const candidates = await searchAmapPoiCandidates(city, name, requestOptions).catch((error) => {
      if (controller.signal.aborted) throw error;
      return [];
    });
    const choice = chooseGeocodeCandidate({ name, aliases: options.aliases }, candidates);
    try {
      options.onCandidates?.({ city, name, candidates, choice });
    } catch {
      // Observers never affect geocoding.
    }
    if (choice.chosen) {
      // AMap typecode 19xxxx is "地名地址信息" (place names / addresses), not a visitable POI.
      const precision = String(choice.chosen.typecode ?? '').startsWith('19') ? GEOCODE_PRECISION.ADDRESS : choice.precision;
      normalized = geocodedStopFields(choice.chosen, 'amap-poi', precision, {
        provider: 'amap',
        method: 'poi-search',
        candidateCount: choice.candidateCount,
        matchType: choice.matchType,
        chosenPoiId: choice.chosen.id,
        chosenName: choice.chosen.name
      });
    } else {
      const address = await geocodeAddressWithAmap(city, name, requestOptions);
      if (address) {
        normalized = geocodedStopFields(address.coordinate, 'amap-geocode', address.precision, {
          provider: 'amap',
          method: 'address-geocode',
          candidateCount: choice.candidateCount,
          matchType: null,
          rejectedReason: choice.reason,
          level: address.level
        });
      }
    }
    if (!normalized) return null;
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

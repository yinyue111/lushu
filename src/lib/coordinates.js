import { cities, getRegionForCity, regionCenters, regionCityGroups } from './chinaCities.js';

export const chinaCenter = { lat: 35.8617, lng: 104.1954, zoom: 4 };
export { cities, regionCityGroups };

export const cityCenters = {
  北京: { lat: 39.9042, lng: 116.4074, zoom: 11 },
  上海: { lat: 31.2304, lng: 121.4737, zoom: 12 },
  广州: { lat: 23.1291, lng: 113.2644, zoom: 11 },
  深圳: { lat: 22.5431, lng: 114.0579, zoom: 11 },
  杭州: { lat: 30.2487, lng: 120.1551, zoom: 12 },
  苏州: { lat: 31.2989, lng: 120.5853, zoom: 12 },
  南京: { lat: 32.0603, lng: 118.7969, zoom: 11 },
  宁波: { lat: 29.8683, lng: 121.544, zoom: 11 },
  无锡: { lat: 31.4912, lng: 120.3119, zoom: 11 },
  厦门: { lat: 24.4798, lng: 118.0894, zoom: 12 },
  福州: { lat: 26.0745, lng: 119.2965, zoom: 11 },
  青岛: { lat: 36.0671, lng: 120.3826, zoom: 11 },
  济南: { lat: 36.6512, lng: 117.1201, zoom: 11 },
  黄山: { lat: 29.7147, lng: 118.3376, zoom: 10 },
  天津: { lat: 39.3434, lng: 117.3616, zoom: 11 },
  秦皇岛: { lat: 39.9354, lng: 119.5996, zoom: 11 },
  大同: { lat: 40.0768, lng: 113.3001, zoom: 11 },
  太原: { lat: 37.8706, lng: 112.5489, zoom: 11 },
  呼和浩特: { lat: 40.8426, lng: 111.7492, zoom: 11 },
  成都: { lat: 30.5728, lng: 104.0668, zoom: 11 },
  重庆: { lat: 29.563, lng: 106.5516, zoom: 11 },
  昆明: { lat: 25.0389, lng: 102.7183, zoom: 11 },
  大理: { lat: 25.6065, lng: 100.2676, zoom: 11 },
  丽江: { lat: 26.855, lng: 100.2278, zoom: 11 },
  贵阳: { lat: 26.647, lng: 106.6302, zoom: 11 },
  西双版纳: { lat: 22.0094, lng: 100.7974, zoom: 10 },
  拉萨: { lat: 29.652, lng: 91.1721, zoom: 11 },
  西安: { lat: 34.3416, lng: 108.9398, zoom: 11 },
  兰州: { lat: 36.0611, lng: 103.8343, zoom: 11 },
  敦煌: { lat: 40.1421, lng: 94.6619, zoom: 10 },
  银川: { lat: 38.4872, lng: 106.2309, zoom: 11 },
  乌鲁木齐: { lat: 43.8256, lng: 87.6168, zoom: 10 },
  喀什: { lat: 39.4704, lng: 75.9898, zoom: 11 },
  武汉: { lat: 30.5928, lng: 114.3055, zoom: 11 },
  长沙: { lat: 28.2282, lng: 112.9388, zoom: 11 },
  张家界: { lat: 29.1167, lng: 110.4792, zoom: 10 },
  郑州: { lat: 34.7466, lng: 113.6254, zoom: 11 },
  洛阳: { lat: 34.6197, lng: 112.454, zoom: 11 },
  南昌: { lat: 28.6829, lng: 115.8582, zoom: 11 },
  沈阳: { lat: 41.8057, lng: 123.4315, zoom: 11 },
  大连: { lat: 38.914, lng: 121.6147, zoom: 11 },
  长春: { lat: 43.8171, lng: 125.3235, zoom: 11 },
  哈尔滨: { lat: 45.8038, lng: 126.5349, zoom: 11 },
  延吉: { lat: 42.8913, lng: 129.5089, zoom: 11 },
  桂林: { lat: 25.2736, lng: 110.2902, zoom: 11 },
  三亚: { lat: 18.2528, lng: 109.5119, zoom: 11 },
  海口: { lat: 20.044, lng: 110.1999, zoom: 11 },
  珠海: { lat: 22.2711, lng: 113.5767, zoom: 11 },
  佛山: { lat: 23.0215, lng: 113.1214, zoom: 11 }
};

// Seed POI reference coordinates, keyed by exact name. `city` scopes each entry so a
// same-named place in another city never inherits these coordinates (M4).
export const knownPoiCoordinates = {
  杭州东站: { lat: 30.2936, lng: 120.2154, city: '杭州' },
  柳浪闻莺: { lat: 30.242, lng: 120.1617, city: '杭州' },
  南宋御街: { lat: 30.2432, lng: 120.1696, city: '杭州' },
  北山街: { lat: 30.2596, lng: 120.1472, city: '杭州' },
  北山街日落线: { lat: 30.2596, lng: 120.1472, city: '杭州' },
  法喜寺: { lat: 30.2366, lng: 120.0954, city: '杭州' },
  龙井茶园: { lat: 30.2248, lng: 120.1032, city: '杭州' },
  茅家埠: { lat: 30.2468, lng: 120.1139, city: '杭州' },
  茅家埠茶歇线: { lat: 30.2468, lng: 120.1139, city: '杭州' },
  浙江美术馆: { lat: 30.2443, lng: 120.1591, city: '杭州' },
  孤山路: { lat: 30.2548, lng: 120.1485, city: '杭州' },
  青芝坞: { lat: 30.2662, lng: 120.1282, city: '杭州' },
  中国美院象山: { lat: 30.1679, lng: 120.078, city: '杭州' },
  武康路: { lat: 31.2123, lng: 121.4382, city: '上海' },
  安福路: { lat: 31.217, lng: 121.4431, city: '上海' },
  湖滨银泰: { lat: 30.2583, lng: 120.1641, city: '杭州' },
  平江路: { lat: 31.3156, lng: 120.6314, city: '苏州' }
};

export function isValidCoordinate(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

function normalizeCityLabel(city) {
  return String(city ?? '')
    .trim()
    .replace(/市$/u, '');
}

/**
 * Looks up a seed reference coordinate for a stop name.
 *
 * M4: exact (trimmed) name match only, optionally scoped to `city`. The previous
 * bidirectional substring match returned the first POI for an empty name
 * (`key.includes('')` is always true) and let unrelated stops inherit
 * "navigable" coordinates from a different place or city.
 * @param {string} name
 * @param {string} [city] when given, the POI must belong to this city
 * @returns {{ lat: number, lng: number } | null}
 */
export function coordinateForName(name, city = '') {
  const text = String(name ?? '').trim();
  if (!text || !Object.prototype.hasOwnProperty.call(knownPoiCoordinates, text)) return null;
  const entry = knownPoiCoordinates[text];
  const wantedCity = normalizeCityLabel(city);
  if (wantedCity && entry.city && entry.city !== wantedCity) return null;
  return { lat: entry.lat, lng: entry.lng };
}

export function fallbackCoordinate(city, _index) {
  const region = getRegionForCity(city);
  const center = cityCenters[city] ?? regionCenters[region] ?? chinaCenter;
  return {
    lat: Number(center.lat.toFixed(6)),
    lng: Number(center.lng.toFixed(6)),
    fallback: true,
    source: cityCenters[city] ? 'city-center' : region ? 'region-center' : 'country-center',
    precision: cityCenters[city] ? 'city' : region ? 'region' : 'country',
    confidence: cityCenters[city] ? 38 : region ? 28 : 20,
    radiusMeters: cityCenters[city] ? 5000 : region ? 80000 : 300000,
    navigationDisabled: true
  };
}

export function normalizeCoordinate(stop, city, index) {
  const lat = Number(stop?.lat);
  const lng = Number(stop?.lng);
  const confidence = Number(stop?.geoConfidence);
  if (isValidCoordinate(lat, lng) && Number.isFinite(confidence) && confidence < 60) {
    return {
      lat,
      lng,
      fallback: true,
      source: stop?.coordinateSource ?? 'low-confidence-input',
      precision: stop?.coordinatePrecision ?? 'approximate',
      confidence,
      radiusMeters: Number(stop?.coordinateRadiusMeters) || 1500,
      navigationDisabled: true
    };
  }
  if (isValidCoordinate(lat, lng)) {
    return {
      lat,
      lng,
      fallback: false,
      source: stop?.coordinateSource ?? 'model-or-user',
      precision: stop?.coordinatePrecision ?? 'exact',
      confidence: Number.isFinite(confidence) ? confidence : 82,
      radiusMeters: Number(stop?.coordinateRadiusMeters) || 0,
      navigationDisabled: stop?.navigationDisabled === true
    };
  }
  return coordinateForName(stop?.name) ?? fallbackCoordinate(city, index);
}

export function distanceKm(from, to) {
  const fromLat = Number(from?.lat);
  const fromLng = Number(from?.lng);
  const toLat = Number(to?.lat);
  const toLng = Number(to?.lng);
  if (!isNavigableCoordinate(from) || !isNavigableCoordinate(to) || !isValidCoordinate(fromLat, fromLng) || !isValidCoordinate(toLat, toLng)) return null;
  const earthRadiusKm = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(toLat - fromLat);
  const dLng = toRad(toLng - fromLng);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(fromLat)) * Math.cos(toRad(toLat)) * Math.sin(dLng / 2) ** 2;
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function routeLegLabel(from, to) {
  const km = distanceKm(from, to);
  if (!Number.isFinite(km)) return '路程待核对';
  const mode = km <= 1.2 ? '步行' : '打车';
  const minutes = mode === '步行' ? Math.max(6, Math.round((km / 4.5) * 60)) : Math.max(12, Math.round((km / 22) * 60 + 8));
  const distLabel = km < 1 ? `${Math.max(0.1, Math.round(km * 10) / 10)} km` : `${km.toFixed(1)} km`;
  return `${mode}约 ${minutes} 分钟 · 直线 ${distLabel}（路线还没查）`;
}

export function isNavigableCoordinate(stop) {
  return (
    isValidCoordinate(Number(stop?.lat), Number(stop?.lng)) &&
    Number(stop?.geoConfidence ?? 0) >= 60 &&
    stop?.navigationDisabled !== true &&
    !['city-center', 'region-center', 'country-center'].includes(String(stop?.coordinateSource ?? ''))
  );
}

/** 没有准确坐标时的出路：在高德按「站名」+ 城市搜，让用户自己挑，不编坐标。 */
export function amapNameSearchUrl(stop, city = '') {
  const params = new URLSearchParams({ keyword: String(stop?.name ?? '').trim(), src: 'trusted-routebook', callnative: '1' });
  const scope = String(city || stop?.city || '').trim();
  if (scope) params.set('city', scope);
  return `https://uri.amap.com/search?${params}`;
}

export function coordinateReviewLabel(stop) {
  if (isNavigableCoordinate(stop)) return '可导航';
  if (isValidCoordinate(Number(stop?.lat), Number(stop?.lng))) return '定位待复核';
  return '缺少坐标';
}

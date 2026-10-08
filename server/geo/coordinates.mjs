// Coordinate scopes, distance warnings and GCJ-02 -> WGS-84 conversion.
import { getRegionForCity, regionCenters } from '../../src/lib/chinaCities.js';
import { distanceMeters, isValidCoordinate } from '../lib/util.mjs';

export const CITY_CENTERS = {
  北京: { lat: 39.9042, lng: 116.4074 },
  上海: { lat: 31.2304, lng: 121.4737 },
  广州: { lat: 23.1291, lng: 113.2644 },
  深圳: { lat: 22.5431, lng: 114.0579 },
  杭州: { lat: 30.2487, lng: 120.1551 },
  苏州: { lat: 31.2989, lng: 120.5853 },
  南京: { lat: 32.0603, lng: 118.7969 },
  宁波: { lat: 29.8683, lng: 121.544 },
  无锡: { lat: 31.4912, lng: 120.3119 },
  厦门: { lat: 24.4798, lng: 118.0894 },
  福州: { lat: 26.0745, lng: 119.2965 },
  青岛: { lat: 36.0671, lng: 120.3826 },
  济南: { lat: 36.6512, lng: 117.1201 },
  黄山: { lat: 29.7147, lng: 118.3376 },
  天津: { lat: 39.3434, lng: 117.3616 },
  秦皇岛: { lat: 39.9354, lng: 119.5996 },
  大同: { lat: 40.0768, lng: 113.3001 },
  太原: { lat: 37.8706, lng: 112.5489 },
  呼和浩特: { lat: 40.8426, lng: 111.7492 },
  成都: { lat: 30.5728, lng: 104.0668 },
  重庆: { lat: 29.563, lng: 106.5516 },
  昆明: { lat: 25.0389, lng: 102.7183 },
  大理: { lat: 25.6065, lng: 100.2676 },
  丽江: { lat: 26.855, lng: 100.2278 },
  贵阳: { lat: 26.647, lng: 106.6302 },
  西双版纳: { lat: 22.0094, lng: 100.7974 },
  拉萨: { lat: 29.652, lng: 91.1721 },
  西安: { lat: 34.3416, lng: 108.9398 },
  兰州: { lat: 36.0611, lng: 103.8343 },
  敦煌: { lat: 40.1421, lng: 94.6619 },
  银川: { lat: 38.4872, lng: 106.2309 },
  乌鲁木齐: { lat: 43.8256, lng: 87.6168 },
  喀什: { lat: 39.4704, lng: 75.9898 },
  武汉: { lat: 30.5928, lng: 114.3055 },
  长沙: { lat: 28.2282, lng: 112.9388 },
  张家界: { lat: 29.1167, lng: 110.4792 },
  郑州: { lat: 34.7466, lng: 113.6254 },
  洛阳: { lat: 34.6197, lng: 112.454 },
  南昌: { lat: 28.6829, lng: 115.8582 },
  沈阳: { lat: 41.8057, lng: 123.4315 },
  大连: { lat: 38.914, lng: 121.6147 },
  长春: { lat: 43.8171, lng: 125.3235 },
  哈尔滨: { lat: 45.8038, lng: 126.5349 },
  延吉: { lat: 42.8913, lng: 129.5089 },
  桂林: { lat: 25.2736, lng: 110.2902 },
  三亚: { lat: 18.2528, lng: 109.5119 },
  海口: { lat: 20.044, lng: 110.1999 },
  珠海: { lat: 22.2711, lng: 113.5767 },
  佛山: { lat: 23.0215, lng: 113.1214 }
};
export const CHINA_CENTER = { lat: 35.8617, lng: 104.1954 };

export function fallbackCoordinate(city, index) {
  const region = getRegionForCity(city);
  const center = CITY_CENTERS[city] ?? regionCenters[region] ?? CHINA_CENTER;
  return {
    lat: Number(center.lat.toFixed(6)),
    lng: Number(center.lng.toFixed(6)),
    fallback: true,
    source: CITY_CENTERS[city] ? 'city-center' : region ? 'region-center' : 'country-center',
    precision: CITY_CENTERS[city] ? 'city' : region ? 'region' : 'country',
    confidence: CITY_CENTERS[city] ? 38 : region ? 28 : 20,
    radiusMeters: CITY_CENTERS[city] ? 5000 : region ? 80000 : 300000,
    navigationDisabled: true
  };
}

export function coordinateScopeForCity(city) {
  const region = getRegionForCity(city);
  if (CITY_CENTERS[city]) {
    return { center: CITY_CENTERS[city], precision: 'city', maxDistanceMeters: 150000 };
  }
  if (region && regionCenters[region]) {
    return { center: regionCenters[region], precision: 'region', maxDistanceMeters: 2000000 };
  }
  return { center: CHINA_CENTER, precision: 'country', maxDistanceMeters: 3200000 };
}

export function coordinateDistanceWarning(lat, lng, city) {
  if (!isValidCoordinate(lat, lng)) return null;
  const scope = coordinateScopeForCity(city);
  const distance = distanceMeters({ lat, lng }, scope.center);
  if (!Number.isFinite(distance) || distance <= scope.maxDistanceMeters) return null;
  return {
    distance,
    scope,
    reason: `坐标距离${city || '目的地'}${scope.precision === 'city' ? '城市中心' : scope.precision === 'region' ? '区域中心' : '全国中心'}约 ${(distance / 1000).toFixed(0)} km，超过可导航校验范围`
  };
}

export function gcj02ToWgs84(lat, lng) {
  if (outOfChina(lat, lng)) return { lat, lng };
  const transformed = transformGcjOffset(lat, lng);
  return { lat: lat * 2 - transformed.lat, lng: lng * 2 - transformed.lng };
}

export function transformGcjOffset(lat, lng) {
  const a = 6378245;
  const ee = 0.006693421622965943;
  let dLat = transformLatitude(lng - 105, lat - 35);
  let dLng = transformLongitude(lng - 105, lat - 35);
  const radLat = (lat / 180) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180) / (((a * (1 - ee)) / (magic * sqrtMagic)) * Math.PI);
  dLng = (dLng * 180) / ((a / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return { lat: lat + dLat, lng: lng + dLng };
}

export function transformLatitude(x, y) {
  let value = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  value += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  value += ((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3;
  value += ((160 * Math.sin((y / 12) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30)) * 2) / 3;
  return value;
}

export function transformLongitude(x, y) {
  let value = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  value += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  value += ((20 * Math.sin(x * Math.PI) + 40 * Math.sin((x / 3) * Math.PI)) * 2) / 3;
  value += ((150 * Math.sin((x / 12) * Math.PI) + 300 * Math.sin((x / 30) * Math.PI)) * 2) / 3;
  return value;
}

export function outOfChina(lat, lng) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

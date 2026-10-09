import { ROUTING_ERROR_CODES, RoutingError } from './errors.mjs';

const GCJ_A = 6378245;
const GCJ_EE = 0.006693421622965943;
const COARSE_COORDINATE_SOURCES = new Set(['city-center', 'region-center', 'country-center']);

export function isValidCoordinate(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

export function routingCoordinateForStop(stop) {
  const lat = coordinateNumber(stop?.lat);
  const lng = coordinateNumber(stop?.lng);
  if (lat == null || lng == null || !isValidCoordinate(lat, lng)) {
    throw new RoutingError(ROUTING_ERROR_CODES.COORDINATES_MISSING, '站点缺少可用经纬度，道路路线未校验', { category: 'input', retryable: false });
  }

  const confidence = Number(stop?.geoConfidence);
  const source = String(stop?.coordinateSource || '')
    .trim()
    .toLowerCase();
  if (stop?.navigationDisabled === true || (Number.isFinite(confidence) && confidence < 60) || COARSE_COORDINATE_SOURCES.has(source)) {
    throw new RoutingError(ROUTING_ERROR_CODES.COORDINATES_UNVERIFIED, '站点坐标尚未达到可导航精度，道路路线未校验', { category: 'input', retryable: false });
  }

  return {
    lat,
    lng,
    coordinateSystem: normalizeCoordinateSystem(stop?.coordinateSystem)
  };
}

export function normalizeCoordinateSystem(value) {
  const normalized = String(value || 'WGS84')
    .replace(/[-_\s]/g, '')
    .toUpperCase();
  return normalized === 'GCJ02' ? 'GCJ02' : 'WGS84';
}

export function coordinateForAmap(point) {
  const lat = coordinateNumber(point?.lat);
  const lng = coordinateNumber(point?.lng);
  if (lat == null || lng == null || !isValidCoordinate(lat, lng)) return null;
  if (normalizeCoordinateSystem(point?.coordinateSystem) === 'GCJ02') return { lat, lng };
  return wgs84ToGcj02(lat, lng);
}

export function wgs84ToGcj02(lat, lng) {
  if (!isValidCoordinate(lat, lng) || outOfChina(lat, lng)) return { lat, lng };
  const offset = transformGcjOffset(lat, lng);
  return { lat: offset.lat, lng: offset.lng };
}

export function gcj02ToWgs84(lat, lng) {
  if (!isValidCoordinate(lat, lng) || outOfChina(lat, lng)) return { lat, lng };
  const transformed = transformGcjOffset(lat, lng);
  return {
    lat: lat * 2 - transformed.lat,
    lng: lng * 2 - transformed.lng
  };
}

function transformGcjOffset(lat, lng) {
  let dLat = transformLatitude(lng - 105, lat - 35);
  let dLng = transformLongitude(lng - 105, lat - 35);
  const radLat = (lat / 180) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - GCJ_EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180) / (((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic)) * Math.PI);
  dLng = (dLng * 180) / ((GCJ_A / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return { lat: lat + dLat, lng: lng + dLng };
}

function transformLatitude(x, y) {
  let value = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  value += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  value += ((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3;
  value += ((160 * Math.sin((y / 12) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30)) * 2) / 3;
  return value;
}

function transformLongitude(x, y) {
  let value = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  value += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  value += ((20 * Math.sin(x * Math.PI) + 40 * Math.sin((x / 3) * Math.PI)) * 2) / 3;
  value += ((150 * Math.sin((x / 12) * Math.PI) + 300 * Math.sin((x / 30) * Math.PI)) * 2) / 3;
  return value;
}

function outOfChina(lat, lng) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function coordinateNumber(value) {
  if (value == null || (typeof value === 'string' && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// Stop coordinate normalisation against the trusted POI catalog.
import { isValidCoordinate, clampNumber, truncateString } from '../lib/util.mjs';
import { findTrustedPoi } from '../poi/catalog.mjs';
import { coordinateDistanceWarning, fallbackCoordinate } from './coordinates.mjs';

export function coordinateForName(name, city = '') {
  const trusted = findTrustedPoi({ name }, city);
  // 运营 POI 可能缺 location 事实：坐标不合法时不作为可信坐标源。
  if (!trusted || !isValidCoordinate(Number(trusted.lat), Number(trusted.lng))) return null;
  return {
    lat: trusted.lat,
    lng: trusted.lng,
    fallback: false,
    source: 'known-poi',
    precision: 'exact',
    confidence: 88,
    radiusMeters: 0,
    navigationDisabled: false
  };
}

export function normalizeCoordinate(stop, city, index) {
  const lat = Number(stop?.lat);
  const lng = Number(stop?.lng);
  const confidence = Number(stop?.geoConfidence);
  const coordinateSource = truncateString(stop?.coordinateSource, 40);
  if (isValidCoordinate(lat, lng) && Number.isFinite(confidence) && confidence < 60) {
    return {
      lat,
      lng,
      fallback: true,
      source: truncateString(stop?.coordinateSource, 40) || 'low-confidence-input',
      precision: truncateString(stop?.coordinatePrecision, 40) || 'approximate',
      confidence: clampNumber(stop?.geoConfidence, 20, 59, 45),
      radiusMeters: clampNumber(stop?.coordinateRadiusMeters, 400, 100000, 1500),
      navigationDisabled: true
    };
  }
  if (isValidCoordinate(lat, lng)) {
    const distanceWarning = coordinateDistanceWarning(lat, lng, city);
    if (distanceWarning) {
      return {
        lat,
        lng,
        fallback: true,
        source: 'out-of-city-input',
        precision: 'approximate',
        confidence: 45,
        radiusMeters: Math.min(100000, Math.max(5000, Math.round(distanceWarning.distance / 20))),
        navigationDisabled: true,
        warning: distanceWarning.reason
      };
    }
    if (coordinateSource === 'model') {
      return {
        lat,
        lng,
        fallback: true,
        source: 'model',
        precision: 'unverified',
        confidence: 55,
        radiusMeters: 1500,
        navigationDisabled: true
      };
    }
    return {
      lat,
      lng,
      fallback: false,
      source: coordinateSource || 'model-or-user',
      precision: truncateString(stop?.coordinatePrecision, 40) || 'exact',
      confidence: clampNumber(stop?.geoConfidence, 60, 99, 82),
      radiusMeters: clampNumber(stop?.coordinateRadiusMeters, 0, 100000, 0),
      navigationDisabled: stop?.navigationDisabled === true
    };
  }
  return coordinateForName(stop?.name, city) ?? fallbackCoordinate(city, index);
}

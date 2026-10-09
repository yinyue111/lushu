import { distanceKm, isNavigableCoordinate } from './coordinates.js';
import { isSupportedCity, normalizeCityLabel } from './chinaCities.js';

export const NEARBY_FILTERS = Object.freeze([
  { value: 'all', label: '全部' },
  { value: 'alternative', label: '替代点' },
  { value: 'toilet', label: '厕所' },
  { value: 'rest', label: '休息点' }
]);
const FACILITY_TYPES = new Map([
  ['toilet', 'toilet'],
  ['public-toilet', 'toilet'],
  ['public_toilet', 'toilet'],
  ['restroom', 'toilet'],
  ['厕所', 'toilet'],
  ['公共厕所', 'toilet'],
  ['公厕', 'toilet'],
  ['卫生间', 'toilet'],
  ['rest', 'rest'],
  ['rest-point', 'rest'],
  ['rest_point', 'rest'],
  ['rest-area', 'rest'],
  ['rest_area', 'rest'],
  ['休息点', 'rest'],
  ['休息区', 'rest'],
  ['游客休息区', 'rest']
]);

export function normalizeFacilityType(value) {
  return (
    FACILITY_TYPES.get(
      String(value ?? '')
        .trim()
        .toLowerCase()
    ) || ''
  );
}
export function formatNearbyDistance(value) {
  const distance = Number(value);
  if (!Number.isFinite(distance) || distance < 0) return '距离待核验';
  return distance < 1 ? `约 ${Math.max(1, Math.round(distance * 1000))}m` : `约 ${distance.toFixed(1)}km`;
}
export function hasNearbyCoordinate(stop) {
  return stop?.lat != null && stop?.lng != null && String(stop.lat).trim() !== '' && String(stop.lng).trim() !== '' && isNavigableCoordinate(stop);
}

// Names or free-text corrections do not establish navigable coordinates. Only
// explicit server coordinate approval may add a new platform candidate.
export function trustedKnowledgeStop(row, city) {
  const poi = row?.trustedPoi ?? row?.poi ?? row;
  if (!poi || normalizeCityLabel(row?.city || poi.city) !== normalizeCityLabel(city)) return null;
  if (![row?.coordinateTrusted, row?.navigationReady, poi.coordinateTrusted, poi.navigationReady].includes(true)) return null;
  const stop = {
    ...poi,
    id: `poi-knowledge-${row.id || poi.id || poi.poiId || poi.name || ''}`,
    poiId: row.poiId || poi.poiId,
    name: row.stopName || row.name || poi.name || poi.stopName || '',
    city: row.city || poi.city,
    area: row.area || poi.area || row.city || poi.city,
    lat: row.lat ?? poi.lat,
    lng: row.lng ?? poi.lng,
    geoConfidence: row.geoConfidence ?? poi.geoConfidence ?? 90,
    coordinateSource: row.coordinateSource || poi.coordinateSource || 'operator-verified',
    navigationDisabled: row.navigationDisabled === true || poi.navigationDisabled === true
  };
  return stop.name && hasNearbyCoordinate(stop) ? stop : null;
}

/** @param {Record<string, any>} options */
export function buildNearbyFacilities({ current, routebook, poiKnowledge = [], limit = 6, maxDistanceKm = 3 } = {}) {
  const city = normalizeCityLabel(routebook?.city || current?.city);
  if (!isSupportedCity(city) || !hasNearbyCoordinate(current)) return [];
  const routeStops = [...(routebook?.stops ?? []), ...(routebook?.variants ?? []).flatMap((variant) => variant.stops ?? [])];
  const candidates = [
    ...routeStops.map((stop) => ({ row: stop, stop, source: '当前路书结构化设施' })),
    ...poiKnowledge.map((row) => ({ row, stop: trustedKnowledgeStop(row, city), source: '平台 POI 库' }))
  ];
  const seen = new Set();
  return candidates
    .map(({ row, stop, source }) => {
      const poi = row?.trustedPoi ?? row?.poi ?? row;
      const facilityType = [row.facilityType, row.facility?.type, poi.facilityType, poi.facility?.type].map(normalizeFacilityType).find(Boolean) || '';
      const reviewStatus = row.facilityReviewStatus || row.facility?.reviewStatus || poi.facilityReviewStatus || poi.facility?.reviewStatus || 'pending';
      return { stop, source, facilityType, reviewStatus };
    })
    .filter(
      ({ stop, facilityType, reviewStatus }) =>
        stop &&
        facilityType &&
        reviewStatus !== 'rejected' &&
        hasNearbyCoordinate(stop) &&
        (!stop.city || normalizeCityLabel(stop.city) === city) &&
        String(stop.id) !== String(current.id)
    )
    .map((candidate) => ({ ...candidate, distance: distanceKm(current, candidate.stop) }))
    .filter(({ distance }) => Number.isFinite(distance) && distance > 0 && distance <= maxDistanceKm)
    .sort((a, b) => Number(b.reviewStatus === 'approved') - Number(a.reviewStatus === 'approved') || a.distance - b.distance)
    .filter(({ stop, facilityType }) => {
      const key = `${stop.poiId || stop.id || stop.name}:${facilityType}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit)
    .map((candidate) => ({
      ...candidate,
      id: `${candidate.facilityType}:${candidate.stop.poiId || candidate.stop.id}`,
      kind: 'facility',
      name: candidate.stop.name,
      type: candidate.facilityType === 'toilet' ? '厕所' : '休息点',
      canNavigate: candidate.reviewStatus === 'approved',
      reason: `${formatNearbyDistance(candidate.distance)}（直线） · ${candidate.source} · ${candidate.reviewStatus === 'approved' ? '设施类型已审' : '设施类型待复核，不可导航'}`
    }));
}

export function filterNearbyRecommendations(items, filter) {
  const rows = Array.isArray(items) ? items : [];
  if (filter === 'all') return rows;
  return rows.filter((row) => (filter === 'alternative' ? row.kind === 'alternative' : row.kind === 'facility' && row.facilityType === filter));
}

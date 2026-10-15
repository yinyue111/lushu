// Road verification is server evidence, not a client-editable trust flag.
import { createHmac } from 'node:crypto';
import { PROFILE_ID_SECRET, MAX_ROUTEBOOK_STOPS } from '../config/index.mjs';
import { safeEqualHex } from '../auth/tokens.mjs';
import { normalizeRouteLeg, unverifiedRouteLeg } from './routeLegs.mjs';
import { RoutingError, ROUTING_ERROR_CODES } from './errors.mjs';
import { routingCoordinateForStop } from './coordinates.mjs';
import { distanceMeters } from '../lib/util.mjs';

export function normalizeStopTransportMode(value) {
  const mode = String(value ?? '')
    .trim()
    .toLowerCase();
  if (['walking', 'driving', 'transit', 'bicycling'].includes(mode)) return mode;
  // "少走路"/"亲子少走路" asks for less walking, so it is not a walking preference.
  if (/少走路|少步行|不想走路/.test(mode)) return 'driving';
  // Mixed preferences such as the builder default "步行 + 打车": walking is the per-leg default and a taxi is the
  // fallback for long hops — verifying every 200 m citywalk hop as a car route misstates the plan.
  if (/步行|走路|walking|\bwalk\b/.test(mode) && /[+＋/、和与或]|打车|出租|地铁|公交/.test(mode)) return 'walking';
  if (/骑行|单车|自行车|bike|bicycl/.test(mode)) return 'bicycling';
  if (/自驾|驾车|开车|打车|出租|网约车|driv|taxi|\bcar\b/.test(mode)) return 'driving';
  if (/公交|地铁|公共交通|巴士|transit|metro|subway|\bbus\b/.test(mode)) return 'transit';
  if (/步行|走路|walking|\bwalk\b/.test(mode)) return 'walking';
  return '';
}

// Straight-line threshold shared with the client's leg estimate (src/lib/coordinates.js routeLegLabel):
// hops longer than this are planned as a ride, not a walk.
export const WALKING_LEG_MAX_METERS = 1200;

function mixedRideMode(text) {
  const ride = /打车|出租|网约车|自驾|驾车|开车|taxi|driv|\bcar\b/.exec(text);
  const transit = /地铁|公交|公共交通|巴士|transit|metro|subway|\bbus\b/.exec(text);
  if (ride && transit) return ride.index <= transit.index ? 'driving' : 'transit';
  if (transit) return 'transit';
  return 'driving';
}

/**
 * The mode a leg is planned (and therefore verified) with:
 * 1. an explicit per-stop transportMode wins;
 * 2. a single-mode preference ("地铁", "自驾") applies to every leg;
 * 3. a mixed or missing preference ("步行 + 打车", "") walks short hops and rides long ones,
 *    matching what the route page tells the traveller.
 */
export function plannedLegMode(from, to, transport) {
  const explicit = normalizeStopTransportMode(to?.transportMode);
  if (explicit) return explicit;
  const text = String(transport ?? '')
    .trim()
    .toLowerCase();
  const preferred = normalizeStopTransportMode(text);
  const mixedWalking = preferred === 'walking' && /[+＋/、和与或]|打车|出租|地铁|公交/.test(text);
  if (preferred && !mixedWalking) return preferred;
  const meters = distanceMeters(from, to);
  if (meters == null || meters <= WALKING_LEG_MAX_METERS) return 'walking';
  return mixedWalking ? mixedRideMode(text) : 'driving';
}

function proofPayload(leg, from, to) {
  const normalized = normalizeRouteLeg(leg);
  const point = (stop) => [String(stop?.id), Number(stop?.lat), Number(stop?.lng), stop?.day || 'Day 1'];
  return JSON.stringify([normalized, point(from), point(to)]);
}

export function signRouteLeg(leg, from, to) {
  return createHmac('sha256', PROFILE_ID_SECRET)
    .update(proofPayload(leg, from, to))
    .digest('hex');
}

export function normalizeStoredRouteLegs(routeLegs, stops = [], transport = '') {
  if (!Array.isArray(routeLegs)) return [];
  const byPair = new Map();
  for (let index = 0; index < stops.length - 1; index += 1) {
    const from = stops[index];
    const to = stops[index + 1];
    if ((from.day || 'Day 1') === (to.day || 'Day 1')) byPair.set(pairKey(from.id, to.id), { from, to });
  }
  const seen = new Set();
  return routeLegs.slice(0, MAX_ROUTEBOOK_STOPS - 1).flatMap((candidate) => {
    const key = pairKey(candidate?.fromStopId, candidate?.toStopId);
    const pair = byPair.get(key);
    if (!pair || seen.has(key)) return [];
    seen.add(key);
    const leg = normalizeRouteLeg(candidate);
    if (leg.status !== 'verified') return [leg];
    const expectedMode = plannedLegMode(pair.from, pair.to, transport);
    let coordinatesUsable = true;
    try {
      routingCoordinateForStop(pair.from);
      routingCoordinateForStop(pair.to);
    } catch {
      coordinatesUsable = false;
    }
    if (coordinatesUsable && leg.mode === expectedMode && safeEqualHex(String(candidate?.proof || ''), signRouteLeg(leg, pair.from, pair.to))) {
      return [{ ...leg, proof: candidate.proof }];
    }
    return [
      unverifiedRouteLeg(
        leg,
        new RoutingError(ROUTING_ERROR_CODES.PROVENANCE_INVALID, '道路结果缺少服务端凭据，或站点/交通方式已经变化，请重新核对', {
          category: 'provenance',
          retryable: true
        })
      )
    ];
  });
}

function pairKey(from, to) {
  return `${String(from)}\u0000${String(to)}`;
}

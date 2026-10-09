// Owner-triggered re-check of a draft: stops the user replaced or moved (coordinates
// from 'user-edit', navigation paused) are re-geocoded with AMap POI search, then only
// the legs touching changed stops are re-verified (verified legs are reused).
import { AMAP_GEOCODE_KEY } from '../config/index.mjs';
import { geocodePoiWithAmap } from '../geo/amap.mjs';
import { isValidCoordinate, mapWithConcurrency } from '../lib/util.mjs';
import { attachServerRouteLegs } from './service.mjs';
import { summarizeRouteExecution } from './routeExecution.mjs';

/** @param {Record<string, any>} stop */
export function stopNeedsGeocode(stop) {
  return stop?.coordinateSource === 'user-edit' || stop?.navigationDisabled === true;
}

/**
 * @param {Record<string, any>} routebook normalized stored routebook
 * @param {AbortSignal} [signal]
 * @param {{ geocode?: typeof geocodePoiWithAmap, attach?: typeof attachServerRouteLegs, geocodingConfigured?: boolean, stopIds?: string[] | null }} [deps]
 *   stopIds limits re-geocoding to these stops (e.g. the one just replaced); default: every stop that needs it.
 */
export async function recheckOwnerRoutebook(routebook, signal, deps = {}) {
  const only = Array.isArray(deps.stopIds) && deps.stopIds.length ? new Set(deps.stopIds.map(String)) : null;
  const geocode = deps.geocode ?? geocodePoiWithAmap;
  const attach = deps.attach ?? attachServerRouteLegs;
  const geocodingConfigured = deps.geocodingConfigured ?? Boolean(AMAP_GEOCODE_KEY);
  /** @type {string[]} */
  const geocoded = [];
  /** @type {string[]} */
  const unresolved = [];
  const stops = await mapWithConcurrency(routebook.stops ?? [], 4, async (stop) => {
    if (!stopNeedsGeocode(stop) || (only && !only.has(String(stop.id)))) return stop;
    if (!geocodingConfigured) {
      unresolved.push(stop.name);
      return stop;
    }
    const hit = await geocode(routebook.city, stop.name, signal).catch(() => null);
    if (!hit || !isValidCoordinate(Number(hit.lat), Number(hit.lng))) {
      unresolved.push(stop.name);
      return stop;
    }
    const { geocodeChoice: _choice, ...fields } = hit;
    geocoded.push(stop.name);
    return { ...stop, ...fields };
  });
  const routed = await attach({ ...routebook, stops }, signal, undefined, { reuseVerifiedLegs: true });
  const routingConfigured = !(routed.routeLegs ?? []).some((leg) => leg?.error?.code === 'ROUTING_PROVIDER_NOT_CONFIGURED');
  return { routebook: routed, geocoded, unresolved, routing: summarizeRouteExecution(routed.stops, routed.routeLegs), geocodingConfigured, routingConfigured };
}

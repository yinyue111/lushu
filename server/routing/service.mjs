import { AMAP_API_BASE_URL, AMAP_ROUTING_KEY, ROUTING_TIMEOUT_MS, ROUTING_CONCURRENCY } from '../config/index.mjs';
import { buildRouteLegs } from './routeLegs.mjs';
import { createAmapRoutingProvider } from './amapProvider.mjs';
import { pacedAmapFetch } from '../geo/amap.mjs';
import { normalizeStopTransportMode, plannedLegMode, signRouteLeg } from './provenance.mjs';
import { buildRoutebookMetrics, buildRoutebookValidations, routebookValidationContext } from '../routebooks/normalize.mjs';

const routingProvider = createAmapRoutingProvider({
  apiKey: AMAP_ROUTING_KEY,
  timeoutMs: ROUTING_TIMEOUT_MS,
  fetchImpl: pacedAmapFetch,
  baseUrl: AMAP_API_BASE_URL
});

/**
 * Wraps a provider so legs that are still verified (server proof checked by
 * normalizeStoredRouteLegs on load, same endpoints and mode) are reused instead of
 * re-queried: a re-check after an edit only spends AMap calls on the touched legs.
 */
export function reuseVerifiedLegsProvider(provider, routeLegs = []) {
  const verified = new Map(
    (Array.isArray(routeLegs) ? routeLegs : [])
      .filter((leg) => leg?.status === 'verified' && leg?.proof)
      .map((leg) => [`${String(leg.fromStopId)}\u0000${String(leg.toStopId)}\u0000${leg.mode}`, leg])
  );
  return {
    ...provider,
    async route(request) {
      const kept = verified.get(`${String(request?.fromStop?.id)}\u0000${String(request?.toStop?.id)}\u0000${request?.mode}`);
      if (kept) {
        return {
          status: 'verified',
          provider: kept.provider,
          mode: kept.mode,
          distanceMeters: kept.distanceMeters,
          durationSeconds: kept.durationSeconds,
          geometry: kept.geometry,
          reusedQueriedAt: kept.queriedAt
        };
      }
      return provider.route(request);
    }
  };
}

export async function attachServerRouteLegs(routebook, signal, provider = routingProvider, { reuseVerifiedLegs = false } = {}) {
  const defaultMode = normalizeStopTransportMode(routebook?.constraints?.transport) || 'walking';
  const legs = await buildRouteLegs({
    routebook,
    provider: reuseVerifiedLegs ? reuseVerifiedLegsProvider(provider, routebook?.routeLegs) : provider,
    defaultMode,
    modeForLeg: ({ from, to }) => plannedLegMode(from, to, routebook?.constraints?.transport),
    concurrency: ROUTING_CONCURRENCY,
    signal
  });
  const stopsById = new Map((routebook.stops ?? []).map((stop) => [String(stop.id), stop]));
  const routeLegs = legs.map((leg) =>
    leg.status === 'verified' ? { ...leg, proof: signRouteLeg(leg, stopsById.get(String(leg.fromStopId)), stopsById.get(String(leg.toStopId))) } : leg
  );
  return {
    ...routebook,
    routeLegs,
    validations: buildRoutebookValidations(routebook.stops ?? [], routebook.validations, '查路线', { ...routebookValidationContext(routebook), routeLegs }),
    metrics: buildRoutebookMetrics(routebook.stops ?? [], routebook.metrics, routeLegs)
  };
}

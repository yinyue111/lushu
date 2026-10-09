import { AMAP_ROUTING_KEY, ROUTING_TIMEOUT_MS, ROUTING_CONCURRENCY } from '../config/index.mjs';
import { buildRouteLegs } from './routeLegs.mjs';
import { createAmapRoutingProvider } from './amapProvider.mjs';
import { normalizeStopTransportMode, signRouteLeg } from './provenance.mjs';
import { buildRoutebookMetrics, buildRoutebookValidations, routebookValidationContext } from '../routebooks/normalize.mjs';

const routingProvider = createAmapRoutingProvider({ apiKey: AMAP_ROUTING_KEY, timeoutMs: ROUTING_TIMEOUT_MS });

export async function attachServerRouteLegs(routebook, signal, provider = routingProvider) {
  const defaultMode = normalizeStopTransportMode(routebook?.constraints?.transport) || 'walking';
  const legs = await buildRouteLegs({
    routebook,
    provider,
    defaultMode,
    modeForLeg: ({ to }) => normalizeStopTransportMode(to?.transportMode) || defaultMode,
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
    validations: buildRoutebookValidations(routebook.stops ?? [], routebook.validations, '道路核验', { ...routebookValidationContext(routebook), routeLegs }),
    metrics: buildRoutebookMetrics(routebook.stops ?? [], routebook.metrics, routeLegs)
  };
}

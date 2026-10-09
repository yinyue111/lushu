/**
 * F12: after an edit, keep only the road legs whose endpoints are still
 * adjacent on the same day with unchanged coordinates / transport mode.
 * Everything else must be re-verified. The server re-checks each kept leg's
 * signed proof on save, so this never upgrades trust.
 * @param {any[]} previousStops
 * @param {any[]} nextStops
 * @param {any[]} routeLegs
 */
export function preserveUnaffectedRouteLegs(previousStops = [], nextStops = [], routeLegs = []) {
  if (!Array.isArray(routeLegs) || !routeLegs.length) return [];
  const fingerprint = (stop) => [Number(stop?.lat), Number(stop?.lng), stop?.day || 'Day 1', stop?.transportMode || ''].join('|');
  const previousById = new Map(previousStops.map((stop) => [String(stop?.id), fingerprint(stop)]));
  const adjacent = new Set();
  for (let index = 0; index < nextStops.length - 1; index += 1) {
    const from = nextStops[index];
    const to = nextStops[index + 1];
    if ((from?.day || 'Day 1') !== (to?.day || 'Day 1')) continue;
    if (previousById.get(String(from?.id)) !== fingerprint(from) || previousById.get(String(to?.id)) !== fingerprint(to)) continue;
    adjacent.add(`${String(from.id)}\u0000${String(to.id)}`);
  }
  return routeLegs.filter((leg) => adjacent.has(`${String(leg?.fromStopId)}\u0000${String(leg?.toStopId)}`));
}

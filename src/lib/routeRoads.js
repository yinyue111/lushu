// Display only complete provider road results. Missing legs remain explicit.
export function roadLegForStops(routeLegs, from, to) {
  if (!from || !to || (from.day || 'Day 1') !== (to.day || 'Day 1')) return null;
  const candidate = (Array.isArray(routeLegs) ? routeLegs : []).find(
    (leg) => String(leg?.fromStopId) === String(from.id) && String(leg?.toStopId) === String(to.id)
  );
  if (candidate?.status !== 'verified' || !candidate?.provider || candidate.provider === 'none' || !Number.isFinite(Date.parse(candidate.queriedAt)))
    return null;
  if (
    candidate.distanceMeters == null ||
    candidate.durationSeconds == null ||
    !Number.isFinite(Number(candidate.distanceMeters)) ||
    !Number.isFinite(Number(candidate.durationSeconds)) ||
    Number(candidate.distanceMeters) < 0 ||
    Number(candidate.durationSeconds) < 0
  )
    return null;
  if (!Array.isArray(candidate.geometry) || candidate.geometry.length < 2) return null;
  if (
    !candidate.geometry.every(
      (point) =>
        Array.isArray(point) &&
        point.length >= 2 &&
        Number.isFinite(point[0]) &&
        Number.isFinite(point[1]) &&
        Math.abs(point[0]) <= 90 &&
        Math.abs(point[1]) <= 180
    )
  )
    return null;
  return candidate;
}

export function roadSummary(stops = [], routeLegs = []) {
  let expectedLegs = 0;
  const verified = [];
  for (let index = 0; index < stops.length - 1; index += 1) {
    if ((stops[index].day || 'Day 1') !== (stops[index + 1].day || 'Day 1')) continue;
    expectedLegs += 1;
    const leg = roadLegForStops(routeLegs, stops[index], stops[index + 1]);
    if (leg) verified.push(leg);
  }
  return {
    expectedLegs,
    verifiedLegs: verified.length,
    complete: expectedLegs > 0 && verified.length === expectedLegs,
    distanceKm: verified.reduce((total, leg) => total + Number(leg.distanceMeters) / 1000, 0),
    durationMinutes: Math.ceil(verified.reduce((total, leg) => total + Number(leg.durationSeconds), 0) / 60)
  };
}

export function roadLegLabel(leg) {
  const mode =
    leg.mode === 'transit' && leg.walkingOnly
      ? '步行（距离近，无需乘车）'
      : { walking: '步行', driving: '驾车', transit: '公共交通', bicycling: '骑行' }[leg.mode] || '道路';
  return `${mode} ${(Number(leg.distanceMeters) / 1000).toFixed(1)} km · 约 ${Math.ceil(Number(leg.durationSeconds) / 60)} 分钟（已查路线）`;
}

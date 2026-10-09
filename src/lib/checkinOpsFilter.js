// Shared by the ops check-in panel and the server-side filter (F17).
export const CHECKIN_OPS_FILTERS = ['all', 'weak', 'invalid', 'correction', 'skipped', 'excluded'];

/** @param {any} item raw check-in row (with ops overlay applied) */
export function checkinMatchesOpsFilter(item, filter) {
  const arrival = item?.arrival && typeof item.arrival === 'object' ? item.arrival : null;
  const confidence = String(arrival?.confidence ?? item?.arrivalConfidence ?? '').toLowerCase();
  if (filter === 'weak') return ['weak', 'unverified'].includes(confidence);
  if (filter === 'invalid') return arrival?.valid === false;
  if (filter === 'correction') return arrival?.usedCoordinateCorrection === true || item?.usedCoordinateCorrection === true;
  if (filter === 'skipped') return ['skipped', 'replaced'].includes(String(item?.status ?? ''));
  if (filter === 'excluded') return Boolean(item?.opsDisposition?.excluded || item?.opsDisposition?.commercialIncentive);
  return true;
}

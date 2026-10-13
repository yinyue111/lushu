/**
 * Pure helpers for post-generation routebook adjustment (L1).
 * Keep side-effect free so unit tests and undo can snapshot freely.
 */
import { orderedDays, reorderStopsByMode } from './routeModes.js';
import { retimeReorderedDays } from './stopTiming.js';

export const LEG_TRANSPORT_OPTIONS = [
  { value: 'walking', label: '步行' },
  { value: 'transit', label: '地铁/公交' },
  { value: 'driving', label: '打车/驾车' },
  { value: 'bicycling', label: '骑行' }
];

export function stopOrigin(stop) {
  return String(stop?.provenance?.origin ?? '').trim();
}

export function isModelSupplementStop(stop) {
  return stopOrigin(stop) === 'model';
}

export function guideBackedRoutebook(routebook) {
  return (routebook?.stops ?? []).some((stop) => stopOrigin(stop) === 'user-guide');
}

/** Drop AI-supplement stops when the book still has guide-backed anchors; keep ≥2 stops. */
export function stripModelSupplementStops(stops, { minStops = 2 } = {}) {
  const list = Array.isArray(stops) ? stops : [];
  const hasGuide = list.some((stop) => stopOrigin(stop) === 'user-guide');
  if (!hasGuide) return { stops: list, removed: 0, skipped: true, reason: 'no-guide-anchor' };
  const kept = list.filter((stop) => !isModelSupplementStop(stop));
  if (kept.length < minStops) {
    return { stops: list, removed: 0, skipped: true, reason: 'would-drop-below-min' };
  }
  return { stops: kept, removed: list.length - kept.length, skipped: false };
}

export function deleteDayStops(stops, day, { minStops = 2 } = {}) {
  const list = Array.isArray(stops) ? stops : [];
  const target = day || 'Day 1';
  const remaining = list.filter((stop) => (stop.day || 'Day 1') !== target);
  if (remaining.length < minStops) {
    return { stops: list, ok: false, reason: 'min-stops' };
  }
  if (remaining.length === list.length) {
    return { stops: list, ok: false, reason: 'day-empty' };
  }
  return { stops: remaining, ok: true, removed: list.length - remaining.length };
}

/** Merge fromDay into toDay (append order), then retime toDay. */
export function mergeDays(stops, fromDay, toDay) {
  const list = Array.isArray(stops) ? [...stops] : [];
  if (!fromDay || !toDay || fromDay === toDay) return { stops: list, ok: false, reason: 'same-day' };
  let moved = 0;
  const next = list.map((stop) => {
    if ((stop.day || 'Day 1') !== fromDay) return stop;
    moved += 1;
    return { ...stop, day: toDay };
  });
  if (!moved) return { stops: list, ok: false, reason: 'from-empty' };
  return {
    stops: retimeReorderedDays(next, [toDay]),
    ok: true,
    moved
  };
}

export function setStopTransportMode(stops, stopId, mode) {
  const normalized = String(mode ?? '').trim().toLowerCase();
  if (!['walking', 'driving', 'transit', 'bicycling'].includes(normalized)) {
    return { stops, ok: false };
  }
  const next = (stops ?? []).map((stop) => (String(stop.id) === String(stopId) ? { ...stop, transportMode: normalized } : stop));
  return { stops: next, ok: true };
}

/**
 * 换店：新站只继承「排在哪、待多久」（id、day、time、stay、交通方式），
 * 旧店的价格、预约、风险、营业时间、攻略来源一律不带过来，改成「待确认」，保存后重新补全。
 * 坐标只有来自高德 / 已审核地点库的候选才算精确、才能导航。
 */
export function replaceStopWithPoi(stops, stopId, poi, { city } = {}) {
  const list = Array.isArray(stops) ? stops : [];
  const index = list.findIndex((stop) => String(stop.id) === String(stopId));
  if (index < 0 || !poi?.name) return { stops: list, ok: false };
  const prev = list[index];
  const name = String(poi.name).trim();
  const lat = Number(poi.lat);
  const lng = Number(poi.lng);
  const hasCoord = Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0);
  const trustedSource = ['amap', 'catalog', 'geocode', 'ops-poi'].includes(String(poi.source ?? ''));
  const precise = hasCoord && trustedSource;
  const nextStop = {
    id: prev.id,
    day: prev.day,
    time: prev.time,
    stay: prev.stay,
    ...(prev.transportMode ? { transportMode: prev.transportMode } : {}),
    name,
    // 区域只取到区县（地址全文放进 address），日标题才不会变成「某某街 152 号」。
    area: String(poi.address || '').match(/^[^\d]{1,6}?[区县市]/)?.[0] || String(city || '').trim(),
    ...(poi.address ? { address: String(poi.address).trim() } : {}),
    lat: precise ? lat : Number.isFinite(Number(prev.lat)) ? Number(prev.lat) : 0,
    lng: precise ? lng : Number.isFinite(Number(prev.lng)) ? Number(prev.lng) : 0,
    geoConfidence: precise ? 70 : 20,
    coordinateSystem: 'WGS84',
    coordinateSource: precise ? 'amap-search' : 'user-edit',
    coordinatePrecision: precise ? 'poi' : 'approximate',
    coordinateRadiusMeters: precise ? 0 : 3000,
    navigationDisabled: !precise,
    provenance: { origin: 'user-added', name, replacedFrom: prev.name },
    cost: '价格待确认',
    costInfo: { known: false, amount: null, min: null, max: null, free: false, reservationRequired: false, text: '价格待确认' },
    verify: '刚换的店：营业时间、价格和是否要预约都待确认',
    risk: precise ? '待确认' : '位置待确认：没有从地图找到准确位置，出发前请自己搜一下'
  };
  const next = [...list];
  next[index] = nextStop;
  const day = nextStop.day || 'Day 1';
  return { stops: retimeReorderedDays(next, [day]), ok: true, stop: nextStop };
}

/** Apply a confirmed L2 proposal ops list onto current stops. */
export function applyPatchOps(stops, ops = [], { days: preferredDays } = {}) {
  let next = Array.isArray(stops) ? [...stops] : [];
  const touchedDays = new Set();
  for (const op of ops) {
    if (!op || typeof op !== 'object') continue;
    if (op.op === 'remove') {
      next = next.filter((stop) => String(stop.id) !== String(op.stopId));
    } else if (op.op === 'replace' && op.stop) {
      const i = next.findIndex((stop) => String(stop.id) === String(op.fromId));
      if (i >= 0) {
        touchedDays.add(op.stop.day || next[i].day || 'Day 1');
        next[i] = { ...next[i], ...op.stop, id: next[i].id };
      }
    } else if (op.op === 'add' && op.stop) {
      next = [...next, op.stop];
      touchedDays.add(op.stop.day || 'Day 1');
    } else if (op.op === 'reorder' && Array.isArray(op.stopIds)) {
      const byId = new Map(next.map((stop) => [String(stop.id), stop]));
      const ordered = op.stopIds.map((id) => byId.get(String(id))).filter(Boolean);
      const rest = next.filter((stop) => !op.stopIds.map(String).includes(String(stop.id)));
      next = [...ordered, ...rest];
      ordered.forEach((stop) => touchedDays.add(stop.day || 'Day 1'));
    } else if (op.op === 'retimes' && op.times) {
      next = next.map((stop) => (op.times[stop.id] ? { ...stop, time: op.times[stop.id] } : stop));
    } else if (op.op === 'setLeg' && op.toId && op.mode) {
      next = next.map((stop) => (String(stop.id) === String(op.toId) ? { ...stop, transportMode: op.mode } : stop));
    }
  }
  if (next.length >= 2 && touchedDays.size) {
    next = retimeReorderedDays(next, [...touchedDays]);
  }
  return {
    stops: next,
    days: orderedDays(next, preferredDays)
  };
}

export function snapshotStops(routebook) {
  return {
    stops: structuredClone(routebook?.stops ?? []),
    days: [...(routebook?.days ?? [])],
    routeLegs: structuredClone(routebook?.routeLegs ?? []),
    validations: structuredClone(routebook?.validations ?? []),
    activeVariantId: routebook?.activeVariantId ?? null,
    editReason: routebook?.provider?.editedAt ? 'undo' : ''
  };
}

export { reorderStopsByMode, retimeReorderedDays, orderedDays };

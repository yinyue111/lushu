// Check-in eligibility, travel-date and plausibility rules used by trust scoring.
import { TRAVEL_DAY_DATE_FORMATTER, TRAVEL_DAY_WINDOW_DAYS, PUBLIC_TRUST_ELIGIBLE_STATES, CHECKIN_COORDINATE_SYSTEMS, CHECKIN_MAX_PLAUSIBLE_KMH, CHECKIN_PLAUSIBILITY_WINDOW_HOURS } from '../config/index.mjs';
import { normalizeTravelDate } from '../routebooks/normalize.mjs';
import { normalizeProfileId } from '../auth/tokens.mjs';
import { resolvePoiId } from '../poi/catalog.mjs';
import { distanceMeters } from '../lib/util.mjs';

export function localDateForTimestamp(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const parts = Object.fromEntries(
    TRAVEL_DAY_DATE_FORMATTER.formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );
  return normalizeTravelDate(`${parts.year}-${parts.month}-${parts.day}`);
}

export function travelDateOrdinal(value) {
  const date = normalizeTravelDate(value);
  if (!date) return null;
  const epoch = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(epoch)) return null;
  return Math.floor(epoch / 86400000);
}

export function isTravelDateEvent(travelDate, event) {
  const plannedOrdinal = travelDateOrdinal(travelDate);
  const eventOrdinal = travelDateOrdinal(localDateForTimestamp(event?.createdAt));
  if (plannedOrdinal == null || eventOrdinal == null) return false;
  return Math.abs(eventOrdinal - plannedOrdinal) <= TRAVEL_DAY_WINDOW_DAYS;
}

// 打卡行事件时间口径：用户补记的 observedAt 为合法日期且与 createdAt 相差
// ≤ 30 天时采用（离线补传/当晚补录仍归入实际到达日），否则回退提交时间，
// 防止伪造远古/远期时间搅乱行程日与时间吻合统计。
export const CHECKIN_OBSERVED_AT_MAX_DRIFT_MS = 30 * 24 * 60 * 60 * 1000;

export function checkinEventTime(item = {}) {
  const fallback = item?.createdAt ?? item?.time;
  const observedMs = Date.parse(item?.observedAt ?? '');
  const createdMs = Date.parse(item?.createdAt ?? '');
  if (
    Number.isFinite(observedMs) &&
    Number.isFinite(createdMs) &&
    Math.abs(observedMs - createdMs) <= CHECKIN_OBSERVED_AT_MAX_DRIFT_MS
  ) {
    return item.observedAt;
  }
  return fallback;
}

// 仅用于打卡行的出行日窗口匹配；exposures 等事件仍走 isTravelDateEvent。
export function isTravelDateCheckin(travelDate, checkin) {
  const plannedOrdinal = travelDateOrdinal(travelDate);
  const eventOrdinal = travelDateOrdinal(localDateForTimestamp(checkinEventTime(checkin)));
  if (plannedOrdinal == null || eventOrdinal == null) return false;
  return Math.abs(eventOrdinal - plannedOrdinal) <= TRAVEL_DAY_WINDOW_DAYS;
}

export function latestCheckinsByStop(checkins = []) {
  const latest = new Map();
  for (const item of checkins) {
    const key = checkinStopKey(item);
    if (!key) continue;
    if (!latest.has(key)) latest.set(key, item);
  }
  return [...latest.values()];
}

export function checkinStopKey(item = {}) {
  return String(item?.localStopKey || item?.stopId || item?.stopName || '').trim();
}

// A phone/WeChat binding is a weighting signal, not an admission gate: gating public
// samples on it stalls every route at "待验证" until a login backend exists. A
// server-issued profile token is still a durable pseudonymous identity, and samples stay
// deduplicated per profile, so profile-owned check-ins count too.
export function isPublicTrustEligibleCheckin(item = {}) {
  return PUBLIC_TRUST_ELIGIBLE_STATES.has(item?.trustState);
}

export function isEligibleTrustCheckin(item = {}) {
  const profileId = normalizeProfileId(item?.profileId);
  return item?.status === 'visited' &&
    isPublicTrustEligibleCheckin(item) &&
    item?.arrival?.valid === true &&
    Boolean(profileId && profileId !== 'anonymous');
}

export function latestTrustedCheckinsByProfileAndStop(checkins = []) {
  const latest = new Map();
  for (const item of checkins) {
    const profileId = normalizeProfileId(item?.profileId);
    const stopKey = checkinStopKey(item);
    if (!profileId || profileId === 'anonymous' || !stopKey) continue;
    const key = `${profileId}:${stopKey}`;
    if (!latest.has(key)) latest.set(key, item);
  }
  return [...latest.values()];
}

export function latestTrustedCheckinsByProfileAndPoi(checkins = []) {
  const latest = new Map();
  for (const item of checkins) {
    const profileId = normalizeProfileId(item?.profileId);
    const poiId = poiCheckinKey(item);
    if (!profileId || profileId === 'anonymous' || !poiId) continue;
    const key = `${profileId}:${poiId}`;
    if (!latest.has(key)) latest.set(key, item);
  }
  return [...latest.values()];
}

export function poiCheckinKey(item = {}) {
  return resolvePoiId(item, item?.city);
}

// rank18①：打卡坐标系白名单（unknown/wgs84/gcj02），未知一律记 unknown。
export function normalizeCheckinCoordinateSystem(value) {
  const system = String(value ?? '').trim().toLowerCase();
  return CHECKIN_COORDINATE_SYSTEMS.has(system) ? system : 'unknown';
}

// With the identity gate relaxed, an implausible jump between consecutive check-ins is
// the main remaining signal that a profile is fabricating arrivals. Downgrade instead of
// rejecting: a legitimate traveller with a bad fix should still keep their feedback.
export function applyTravelPlausibility(arrival, gps, previousCheckin) {
  if (!arrival?.valid || !gps || !previousCheckin?.gps) return arrival;
  const previousAt = Date.parse(previousCheckin.createdAt ?? previousCheckin.time ?? '');
  if (!Number.isFinite(previousAt)) return arrival;
  const elapsedHours = (Date.now() - previousAt) / 3600000;
  if (elapsedHours <= 0 || elapsedHours > CHECKIN_PLAUSIBILITY_WINDOW_HOURS) return arrival;
  const jumpMeters = distanceMeters(gps, previousCheckin.gps);
  if (!Number.isFinite(jumpMeters)) return arrival;
  const impliedKmh = jumpMeters / 1000 / elapsedHours;
  if (impliedKmh <= CHECKIN_MAX_PLAUSIBLE_KMH) return arrival;
  return {
    ...arrival,
    valid: false,
    confidence: 'weak',
    label: '移动速度异常',
    detail: `距上一次打卡 ${Math.round(jumpMeters / 1000)}km、间隔 ${elapsedHours.toFixed(1)} 小时，隐含时速约 ${Math.round(impliedKmh)}km/h，暂不计入有效到达。`,
    fraudSignal: 'implausible-speed',
    impliedKmh: Math.round(impliedKmh)
  };
}

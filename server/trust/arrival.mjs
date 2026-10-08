// Arrival evidence for check-ins.
import { isValidCoordinate, normalizeCityName, sanitizePublicId, truncateString, clampNumber, distanceMeters } from '../lib/util.mjs';
import { normalizePoiName, resolvePoiId } from '../poi/catalog.mjs';
import { getResolvableRoutebook, hasPreciseCoordinate } from '../routebooks/normalize.mjs';
import { listSavedRoutebooks } from '../routebooks/list.mjs';
import { CHECKIN_GCJ_CORRECTION_MAX_METERS, CHECKIN_GCJ_CORRECTION_MIN_METERS, CHECKIN_MAX_REPORTED_ACCURACY_METERS, CHECKIN_TRUSTED_ACCURACY_METERS } from '../config/index.mjs';
import { gcj02ToWgs84 } from '../geo/coordinates.mjs';
import { normalizeCheckinCoordinateSystem } from './checkins.mjs';

export async function findStopForCheckin(body) {
  const routeId = sanitizePublicId(body?.routeId || body?.publicId);
  const routeTitle = truncateString(body?.routeTitle, 100);
  const city = body?.city ? normalizeCityName(body.city) : '';
  let routebook = routeId ? await getResolvableRoutebook(routeId) : null;
  if (!routebook) {
    const [matched] = await listSavedRoutebooks(1, (item) => {
      const titleMatched = !routeTitle || item.title === routeTitle;
      const cityMatched = !city || item.city === city;
      return titleMatched && cityMatched;
    });
    routebook = matched ?? null;
  }
  const target = body?.target && typeof body.target === 'object' ? body.target : null;
  const fallbackTarget = isValidCoordinate(Number(target?.lat), Number(target?.lng))
    ? {
        id: truncateString(body?.stopId, 80),
        localStopKey: truncateString(body?.localStopKey || body?.stopId, 120),
        poiId: resolvePoiId({ name: body?.stopName }, city),
        name: truncateString(body?.stopName, 80),
        lat: Number(target.lat),
        lng: Number(target.lng)
      }
    : null;
  if (!routebook?.stops?.length) return fallbackTarget;
  const resolvedStop = (stop) => ({
    ...stop,
    city: routebook.city,
    serverResolved: true
  });
  const stopId = String(body?.stopId ?? '');
  const stopName = String(body?.stopName ?? '');
  const routeStops = [
    ...(routebook.stops ?? []),
    ...(routebook.variants ?? []).flatMap((variant) => variant?.stops ?? [])
  ];
  const byId = routeStops.find((stop) => stopId && String(stop.id) === stopId);
  if (byId) return resolvedStop(byId);
  const normalizedName = normalizePoiName(stopName);
  const byName = routeStops.find((stop) => normalizedName && normalizePoiName(stop.name) === normalizedName);
  if (byName) return resolvedStop(byName);
  const requestedPoiId = resolvePoiId({ name: stopName }, city || routebook.city);
  const byPoiId = routeStops.find((stop) => resolvePoiId(stop, routebook.city) === requestedPoiId);
  return byPoiId ? resolvedStop(byPoiId) : fallbackTarget;
}

export function buildArrivalEvidence(body, targetStop) {
  const gps = body?.gps && typeof body.gps === 'object' ? {
    lat: clampNumber(body.gps.lat, -90, 90, 0),
    lng: clampNumber(body.gps.lng, -180, 180, 0),
    accuracy: clampNumber(body.gps.accuracy, 0, 10000, 0)
  } : null;
  if (!gps || !isValidCoordinate(gps.lat, gps.lng)) {
    return {
      valid: false,
      confidence: 'unverified',
      label: '未定位',
      detail: '未提供有效 GPS，只能作为普通体验反馈，暂不计入有效到达。',
      distanceMeters: null,
      accuracy: gps?.accuracy ?? null,
      thresholdMeters: null
    };
  }
  if (!targetStop || !isValidCoordinate(Number(targetStop.lat), Number(targetStop.lng))) {
    return {
      valid: false,
      confidence: 'unverified',
      label: '缺少目标坐标',
      detail: '已记录 GPS，但未找到可比对的路书站点坐标。',
      distanceMeters: null,
      accuracy: gps.accuracy,
      thresholdMeters: null
    };
  }
  if (!hasPreciseCoordinate(targetStop)) {
    return {
      valid: false,
      confidence: 'unverified',
      label: '目标定位待复核',
      detail: '该站点不是高置信坐标，只记录体验反馈，暂不计入有效到达。',
      distanceMeters: null,
      accuracy: gps.accuracy,
      thresholdMeters: null,
      targetStopId: truncateString(targetStop.id, 80),
      targetStopName: truncateString(targetStop.name, 80)
    };
  }
  const reportedDistance = distanceMeters(gps, targetStop);
  // rank18②：国内浏览器可能返回 GCJ02 坐标。当按 WGS84 直算的距离落在
  // 250-800m 灰区且客户端未声明 wgs84 时，把上报坐标视作 GCJ02 纠偏后重算，
  // 取更小者作为判定距离；纠偏后仍超阈值则维持原判定。
  const coordinateSystem = normalizeCheckinCoordinateSystem(body?.gps?.coordinateSystem);
  let distance = reportedDistance;
  let correctedDistance = null;
  let usedCoordinateCorrection = false;
  if (coordinateSystem !== 'wgs84' &&
    Number.isFinite(reportedDistance) &&
    reportedDistance >= CHECKIN_GCJ_CORRECTION_MIN_METERS &&
    reportedDistance <= CHECKIN_GCJ_CORRECTION_MAX_METERS) {
    const corrected = gcj02ToWgs84(gps.lat, gps.lng);
    correctedDistance = distanceMeters(corrected, targetStop);
    if (Number.isFinite(correctedDistance) && correctedDistance < reportedDistance) {
      distance = correctedDistance;
      usedCoordinateCorrection = true;
    }
  }
  // accuracy is self-reported, so it can only widen the radius up to a plausible GPS
  // error. A wildly large value now reads as a bad fix instead of buying 900m of slack.
  const reportedAccuracy = gps.accuracy || 0;
  const threshold = Math.max(250, Math.round(Math.min(reportedAccuracy, CHECKIN_TRUSTED_ACCURACY_METERS) + 180));
  const accuracyImplausible = reportedAccuracy > CHECKIN_MAX_REPORTED_ACCURACY_METERS;
  const distanceConfidence = distance <= threshold
    ? 'valid'
    : distance <= Math.max(1000, threshold * 2)
      ? 'weak'
      : 'invalid';
  const confidence = accuracyImplausible && distanceConfidence === 'valid' ? 'weak' : distanceConfidence;
  return {
    valid: confidence === 'valid',
    confidence,
    label: confidence === 'valid' ? '有效到达' : confidence === 'weak' ? '弱定位' : '疑似偏离',
    detail: confidence === 'valid'
      ? `GPS 距目标约 ${distance}m，已计入有效到达。${usedCoordinateCorrection ? '（已按 GCJ02 纠偏取更近距离）' : ''}`
      : accuracyImplausible
        ? `GPS 距目标约 ${distance}m，但上报定位误差 ${Math.round(reportedAccuracy)}m 过大，不计入高置信到达。`
        : confidence === 'weak'
          ? `GPS 距目标约 ${distance}m，位置接近但不计入高置信到达。`
          : `GPS 距目标约 ${distance}m，偏离过大，不计入完成率。`,
    distanceMeters: distance,
    ...(usedCoordinateCorrection
      ? {
          usedCoordinateCorrection: true,
          reportedDistanceMeters: reportedDistance,
          correctedDistanceMeters: correctedDistance
        }
      : {}),
    accuracy: gps.accuracy,
    thresholdMeters: threshold,
    targetStopId: truncateString(targetStop.id, 80),
    targetStopName: truncateString(targetStop.name, 80)
  };
}

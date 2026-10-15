// Pure helpers for the in-trip page (progress, review, alternatives, navigation).
// Extracted verbatim from the former monolithic TripView.jsx.
import { distanceKm } from '../../lib/coordinates';
import { hasNearbyCoordinate, trustedKnowledgeStop } from '../../lib/nearbyRecommendations';
import { normalizeTripStops, tripRoutebookId } from '../../lib/tripSession';
import { greedyModeOrder } from '../../lib/routeModes';
import { checkinEvidenceState, isLocallyProcessedCheckin, isServerSyncedCheckin, listQueuedCheckins } from '../../lib/checkinQueue';

// 打卡不需要路书写凭证（editToken），payload 里不带，减少凭证暴露面。
export function buildCheckinPayload(routebook, stop, profile, data) {
  return {
    profileId: profile.id,
    routeId: tripRoutebookId(routebook),
    routeTitle: routebook.title,
    city: routebook.city,
    stopId: stop?.id,
    stopName: stop?.name,
    localStopKey: stopKeyForStop(stop),
    target: stop ? { lat: stop.lat, lng: stop.lng } : null,
    ...data,
    time: new Date().toISOString()
  };
}

export function buildPendingCheckin(routebook, stop, profile, data, clientAction) {
  return {
    ...buildCheckinPayload(routebook, stop, profile, data),
    clientLocalId: createClientCheckinId(),
    clientSyncStatus: 'queued',
    clientSyncError: '',
    clientAction
  };
}

export function createClientCheckinId() {
  if (globalThis.crypto?.randomUUID) return `checkin-${globalThis.crypto.randomUUID()}`;
  return `checkin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export { nextStopEta, isTripLiveToday } from '../../lib/stopTiming';

export function buildReview(checkins, stops) {
  if (!checkins.length) return '记录到达后会自动沉淀完成度、花费、排队和踩坑反馈';
  const progress = summarizeProgress(checkins, stops);
  const stopIds = new Set((stops ?? []).map(stopKeyForStop));
  const routeCheckins = checkins.filter((item) => isServerSyncedCheckin(item) && stopIds.has(checkinKey(item)));
  const pitfallCount = routeCheckins.filter((item) => item.status === 'visited' && (item.worth === '踩坑' || item.pitfall)).length;
  return `有效到达 ${progress.validArrivals}/${stops.length} 站，公开可信样本 ${progress.publicTrustSamples} 站，踩坑 ${pitfallCount} 条`;
}

export function safeReadCheckins(storageKey) {
  try {
    const rows = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

export function summarizeProgress(checkins, stops) {
  const stopIds = new Set((stops ?? []).map(stopKeyForStop));
  const latestByStop = new Map();
  for (const item of checkins ?? []) {
    const key = checkinKey(item);
    if (!key || !stopIds.has(key)) continue;
    latestByStop.set(key, item);
  }
  const locallyProcessedRows = [...latestByStop.values()].filter(isLocallyProcessedCheckin);
  const syncedRows = [...latestByStop.values()].filter(isServerSyncedCheckin);
  const syncedFeedbackRows = syncedRows.filter((item) => item.status === 'visited');
  const skipped = locallyProcessedRows.filter((item) => item.status === 'skipped' || item.worth === '跳过').length;
  const replaced = (checkins ?? []).filter((item) => isLocallyProcessedCheckin(item) && (item.status === 'replaced' || item.worth === '替换')).length;
  const visited = locallyProcessedRows.filter((item) => item.status === 'visited').length;
  const validArrivals = syncedFeedbackRows.filter((item) => checkinEvidenceState(item).validArrival).length;
  const publicTrustSamples = syncedRows.filter((item) => checkinEvidenceState(item).countsTowardPublicTrust).length;
  const lowConfidenceArrivals = syncedFeedbackRows.filter((item) => ['weak', 'invalid'].includes(item.arrivalConfidence || item.arrival?.confidence)).length;
  const feedbackOnly = Math.max(0, syncedFeedbackRows.length - validArrivals - lowConfidenceArrivals);
  const processed = locallyProcessedRows.length;
  return {
    visited,
    skipped,
    replaced,
    validArrivals,
    publicTrustSamples,
    lowConfidenceArrivals,
    feedbackOnly,
    processed,
    progress: stops.length ? Math.min(100, Math.round((processed / stops.length) * 100)) : 0
  };
}

export function latestCheckinsByStop(checkins) {
  const latest = new Map();
  for (const item of checkins ?? []) {
    const key = checkinKey(item);
    if (key) latest.set(key, item);
  }
  return latest;
}

export function stopKeyForStop(stop) {
  return String(stop?.id ?? '').trim();
}

export function checkinKey(item) {
  return String(item?.localStopKey ?? item?.stopId ?? '').trim();
}

export function queuedCheckinsByTime(checkins) {
  return [...listQueuedCheckins(checkins)].sort((left, right) => {
    const leftTime = String(left?.time ?? left?.createdAt ?? '');
    const rightTime = String(right?.time ?? right?.createdAt ?? '');
    return leftTime.localeCompare(rightTime) || String(left?.clientLocalId ?? '').localeCompare(String(right?.clientLocalId ?? ''));
  });
}

export function latestCheckinByTime(checkins) {
  return (
    [...(checkins ?? [])].sort((left, right) => {
      const leftTime = String(left?.time ?? left?.createdAt ?? '');
      const rightTime = String(right?.time ?? right?.createdAt ?? '');
      return rightTime.localeCompare(leftTime) || String(right?.clientLocalId ?? '').localeCompare(String(left?.clientLocalId ?? ''));
    })[0] ?? null
  );
}

export function checkinForStatusDisplay(checkins) {
  const rows = checkins ?? [];
  return (
    rows.find((item) => item?.clientSyncStatus === 'syncing') ??
    rows.find((item) => item?.clientSyncStatus === 'failed') ??
    queuedCheckinsByTime(rows)[0] ??
    latestCheckinByTime(rows)
  );
}

// cloudSyncOff: this device has not turned on 云端同步 yet.
/** @param {string} status @param {any} row @param {{ cloudSyncOff?: boolean }} [options] */
export function syncStatusLabel(status, row, options = {}) {
  const cloudSyncOff = Boolean(options.cloudSyncOff);
  if (status === 'syncing') return '正在上传';
  if (status === 'synced') return '已保存到云端';
  if (status === 'failed') return row?.clientSyncRetryable === false ? '上传失败，请手动重试' : '上传失败，稍后自动重试';
  // Without 云端同步 nothing uploads, online or not; do not promise an automatic upload.
  if (cloudSyncOff) return '只存在这台设备上';
  return '联网后自动上传';
}

export function publicTrustEvidenceLabel(row, evidence) {
  if (row?.status === 'skipped' || row?.status === 'replaced') {
    return '跳过或替换的站点不算到达。';
  }
  if (evidence.syncStatus !== 'synced') {
    return '上传并核对通过后，才会计入路线可信度。';
  }
  if (evidence.countsTowardPublicTrust) {
    return '已计入可信度：GPS 确认到达，账号已确认（尚未接入实名认证）。';
  }
  if (evidence.validArrival && !evidence.identityAttested) {
    return '未计入可信度：GPS 确认到达，但账号还没完成确认。';
  }
  if (evidence.arrivalConfidence === 'weak') {
    return '普通反馈：离站点很近，但定位不够准，不计入可信度。';
  }
  if (evidence.arrivalConfidence === 'invalid') {
    return '普通反馈：定位离站点较远，不计入可信度。';
  }
  return '普通反馈：没有有效定位，不计入可信度。';
}

export function buildAlternatives(current, routebook, activeStops, latestByStop, poiKnowledge = []) {
  if (!current || !hasNearbyCoordinate(current)) return [];
  const currentCategory = stopCategory(current);
  const decorate = (candidate) => {
    const category = stopCategory(candidate.stop);
    const distance = distanceKm(current, candidate.stop);
    const sameArea = Boolean(current.area && candidate.stop.area && current.area === candidate.stop.area);
    const categoryMatch = category !== '其他' && category === currentCategory;
    return { ...candidate, category, distance, sameArea, categoryMatch };
  };

  // 平台 POI 库（运营审核过的修正知识）按与当前站点的距离排序，取前 3 个。
  const platformCandidates = buildPlatformAlternatives(current, routebook, latestByStop, poiKnowledge)
    .map(decorate)
    .filter((candidate) => Number.isFinite(candidate.distance) && candidate.distance > 0 && candidate.distance <= 8)
    .sort((a, b) => {
      const distanceA = Number.isFinite(a.distance) ? a.distance : Number.POSITIVE_INFINITY;
      const distanceB = Number.isFinite(b.distance) ? b.distance : Number.POSITIVE_INFINITY;
      return distanceA - distanceB;
    })
    .slice(0, 3);

  // 平台库无数据/接口失败时回退路书内候选，来源文案标注为「路书内替代站点」。
  const routeSourceLabel = (label) => (platformCandidates.length ? label : '路书内替代站点');
  const sources = [
    { label: routeSourceLabel('主路线'), stops: routebook?.stops ?? [] },
    ...(routebook?.variants ?? []).map((variant) => ({ label: routeSourceLabel(variant.label || `${variant.mode || '路线'}变体`), stops: variant.stops ?? [] }))
  ];
  const candidates = new Map();
  for (const source of sources) {
    for (const stop of normalizeTripStops(routebook, source.stops)) {
      const key = stopKeyForStop(stop);
      if (!key || !hasNearbyCoordinate(stop) || key === stopKeyForStop(current) || isLocallyProcessedCheckin(latestByStop.get(key))) continue;
      if (!candidates.has(key)) candidates.set(key, { stop, source: source.label });
    }
  }
  const routeCandidates = [...candidates.values()]
    .map(decorate)
    .filter((candidate) => Number.isFinite(candidate.distance) && candidate.distance <= 8)
    .sort((a, b) => {
      if (a.categoryMatch !== b.categoryMatch) return a.categoryMatch ? -1 : 1;
      if (a.sameArea !== b.sameArea) return a.sameArea ? -1 : 1;
      const distanceA = Number.isFinite(a.distance) ? a.distance : Number.POSITIVE_INFINITY;
      const distanceB = Number.isFinite(b.distance) ? b.distance : Number.POSITIVE_INFINITY;
      return distanceA - distanceB || String(a.stop.name ?? '').localeCompare(String(b.stop.name ?? ''), 'zh-CN');
    });

  const combined = [];
  const seenNames = new Set([String(current.name ?? '').trim()]);
  for (const candidate of [...platformCandidates, ...routeCandidates]) {
    const name = String(candidate.stop.name ?? '').trim();
    if (!name || seenNames.has(name)) continue;
    seenNames.add(name);
    combined.push(candidate);
    if (combined.length >= 5) break;
  }
  return combined.map((candidate) => ({
    ...candidate,
    name: candidate.stop.name,
    type: `${candidate.category} · ${candidate.source}`,
    reason: alternativeReason(candidate, currentCategory, activeStops)
  }));
}

// 平台纠错内容本身不证明坐标可信，只有服务端明确核验的坐标可用于替换。
export function buildPlatformAlternatives(current, routebook, latestByStop, poiKnowledge) {
  const seen = new Set();
  const candidates = [];
  for (const row of Array.isArray(poiKnowledge) ? poiKnowledge : []) {
    const canonical = trustedKnowledgeStop(row, routebook?.city);
    if (!canonical) continue;
    const name = String(canonical.name).trim();
    if (!name || name === String(current?.name ?? '').trim() || seen.has(name)) continue;
    seen.add(name);
    const stop = {
      ...canonical,
      name,
      day: current?.day,
      time: current?.time,
      verify: `平台地点库人工核实：${row?.field || '综合信息'}${row?.value ? ` · ${row.value}` : ''}`.slice(0, 120),
      risk: String(row?.reason ?? '').slice(0, 120)
    };
    if (isLocallyProcessedCheckin(latestByStop.get(stopKeyForStop(stop)))) continue;
    candidates.push({ stop, source: '平台 POI 库' });
  }
  return candidates;
}

export function buildAlternativeStop(current, alternative) {
  const candidate = alternative.stop;
  return {
    ...candidate,
    day: current?.day || candidate.day,
    time: current?.time || candidate.time,
    tripOriginalDay: candidate.day,
    tripOriginalTime: candidate.time,
    tripReplacementFor: current?.id,
    tripStatus: 'pending',
    verify: candidate.verify || `来自${alternative.source}的真实替代站点`,
    risk: candidate.risk || alternative.reason
  };
}

export function buildStopsForMode(mode, sourceStops, routebook, anchorStop, processedKeys) {
  const matchingVariant = (routebook?.variants ?? []).find((variant) => variant.mode === mode || String(variant.label ?? '').includes(mode));
  if (matchingVariant?.stops?.length) {
    const seen = new Set();
    const variantStops = normalizeTripStops(routebook, matchingVariant.stops).filter((stop) => {
      const key = stopKeyForStop(stop);
      if (!key || processedKeys.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (variantStops.length) {
      return { stops: variantStops, source: `采用现有「${matchingVariant.label || `${mode}版`}」路线变体` };
    }
  }

  // 贪心重排复用 lib/routeModes 的共享实现，与行前「一键重排」保持同一套权重。
  const days = [...new Set(sourceStops.map((stop) => stop.day || 'Day 1'))];
  let anchor = anchorStop;
  const ordered = [];
  for (const day of days) {
    const dayStops = sourceStops.filter((stop) => (stop.day || 'Day 1') === day);
    const reordered = greedyModeOrder(dayStops, anchor, mode);
    ordered.push(...reordered);
    anchor = reordered.at(-1) ?? anchor;
  }
  return {
    stops: ordered,
    source: mode === '雨天' ? '按室内属性与相邻距离重新计算' : '按站点坐标与区域做最近邻重排'
  };
}

export function navigationForStop(stops, currentIndex, routebook, latestByStop) {
  const current = stops[currentIndex];
  const previous =
    [...stops.slice(0, currentIndex)].reverse().find((stop) => {
      const checkin = latestByStop.get(stopKeyForStop(stop));
      return checkin?.status !== 'skipped' && checkin?.status !== 'replaced' && checkin?.worth !== '跳过' && checkin?.worth !== '替换';
    }) ?? stops[currentIndex - 1];
  const distance = previous && current ? distanceKm(previous, current) : null;
  // 站点上并没有 transport/transfer 之类的转场字段；从实际存在的 verify/risk 文本
  // 与路书约束里的交通偏好推断导航模式。
  const legHint = `${current?.verify ?? ''} ${current?.risk ?? ''}`;
  const routeHint = String(routebook?.constraints?.transport ?? '');
  let mode = 'walk';
  if (/打车|驾车|自驾|租车|网约车|car/i.test(legHint)) mode = 'car';
  else if (/步行|走路|walk/i.test(legHint)) mode = 'walk';
  else if (Number.isFinite(distance)) mode = distance <= 1.5 ? 'walk' : 'car';
  else if (/打车|驾车|自驾|地铁|少走路|少换乘|car/i.test(routeHint)) mode = 'car';
  return {
    mode,
    label: mode === 'car' ? '驾车导航' : '步行导航'
  };
}

export function stopCategory(stop) {
  const text = `${stop?.name ?? ''} ${stop?.area ?? ''} ${stop?.verify ?? ''} ${stop?.risk ?? ''}`;
  if (/馆|展|博物|美术|书店|剧场|艺术/.test(text)) return '展馆文化';
  if (/餐|饭|小吃|咖啡|茶|酒吧|甜品|店/.test(text)) return '餐饮休息';
  if (/寺|庙|教堂|道观/.test(text)) return '人文宗教';
  if (/园|湖|山|江|河|街|巷|古镇|景区|公园/.test(text)) return '户外景点';
  if (/商场|银泰|中心|购物/.test(text)) return '室内商业';
  return '其他';
}

export function alternativeReason(candidate, currentCategory, activeStops) {
  const details = [];
  if (Number.isFinite(candidate.distance)) {
    details.push(candidate.distance < 1 ? `距当前约 ${Math.round(candidate.distance * 1000)} m` : `距当前约 ${candidate.distance.toFixed(1)} km`);
  } else if (candidate.sameArea) {
    details.push(`同在${candidate.stop.area}`);
  } else {
    details.push(`位于${candidate.stop.area || '当前目的地区域'}`);
  }
  if (candidate.categoryMatch) details.push(`与当前同属${currentCategory}`);
  else details.push(`可切换为${candidate.category}`);
  if (activeStops.some((stop) => stopKeyForStop(stop) === stopKeyForStop(candidate.stop))) details.push('将同步移除后续重复站点');
  return details.join('，');
}

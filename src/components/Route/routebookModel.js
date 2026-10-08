// Pure routebook helpers used by the route page (editing, metrics, trust state).
// Extracted verbatim from the former monolithic RouteView.jsx.
import { cityCenters, isValidCoordinate } from '../../lib/coordinates';
import { clickStorageKey, safeWriteJsonStorage } from '../../lib/storage';
import { getProfile } from '../../lib/profile';
import { isExternalSearchEntry } from '../../lib/products';
import { PUBLIC_TRUST_SAMPLE_THRESHOLD, formatVerifiedDate, getRouteTrustPresentation } from '../../lib/trust';

export function currentRoutebookVersion(routebook) {
  const version = Number(routebook?.version ?? routebook?.currentVersion ?? routebook?.revision);
  return Number.isInteger(version) && version >= 0 ? version : null;
}

// seq 不匹配、整份服务端响应被丢弃时，仍把单调递增的版本标量与编辑凭证
// 合入最新引用（服务端版本更大才覆盖，就地写同一对象以免被下次渲染重置），
// 否则后续保存会带着旧 expectedVersion 而必然 409。
export function adoptNewerServerVersionScalars(target, serverRoutebook) {
  if (!target || !serverRoutebook) return;
  const serverVersion = currentRoutebookVersion(serverRoutebook);
  const targetVersion = currentRoutebookVersion(target);
  if (serverVersion == null || (targetVersion != null && serverVersion <= targetVersion)) return;
  if (serverRoutebook.version !== undefined) target.version = serverRoutebook.version;
  if (serverRoutebook.currentVersion !== undefined) target.currentVersion = serverRoutebook.currentVersion;
  if (serverRoutebook.editToken) target.editToken = serverRoutebook.editToken;
}

// 本地编辑（provider.editedAt）晚于最近一次服务端同步（updatedAt）即视为有未同步内容。
export function hasUnsyncedLocalEdits(routebook) {
  const editedAt = Date.parse(routebook?.provider?.editedAt ?? '');
  if (!Number.isFinite(editedAt)) return false;
  const syncedAt = Date.parse(routebook?.updatedAt ?? '');
  return !Number.isFinite(syncedAt) || editedAt > syncedAt;
}

// 变体保存成功后只合并服务端派生字段，保留本地 stops/days/validations/metrics，
// 防止服务端返回的旧 stops 覆盖用户本地未保存的删除/拖拽/替换编辑。
export function mergeServerDerivedRoutebookFields(base, serverRoutebook) {
  if (!serverRoutebook) return base;
  const merged = { ...base };
  const derivedFields = [
    'variants',
    'activeVariantId',
    'version',
    'currentVersion',
    'parentVersion',
    'schemaVersion',
    'revision',
    'trustScore',
    'trustMeta',
    'feedbackSummary',
    'sourceSummary',
    'copyCount',
    'editToken',
    'updatedAt',
    'changeReason',
    'actorType'
  ];
  for (const field of derivedFields) {
    if (serverRoutebook[field] !== undefined) merged[field] = serverRoutebook[field];
  }
  return merged;
}

// 把服务端返回的 click 行（含 id/createdAt/productTitle）回写本地存储，
// 使“我的页”本地/服务端点击去重键能对上；profileId 保持本地口径以便按用户过滤。
export function mergeServerClickIntoLocal(localPayload, serverClick, profileId) {
  const merged = { ...localPayload, ...serverClick, profileId: localPayload?.profileId ?? profileId };
  const rest = safeReadClicks().filter(
    (row) => row?.id !== serverClick?.id && !(row?.clickedAt === localPayload?.clickedAt && row?.productId === localPayload?.productId)
  );
  safeWriteJsonStorage(clickStorageKey(profileId), [merged, ...rest].slice(0, 100));
}

// 优先消费服务端透传的 linkType/deepLinkStatus：种子搜索卡（seed-search/search）
// 或深链未就绪（deepLinkStatus 非 ready/verified）一律明示「外部搜索入口」。
export function productLinkLabel(item) {
  if (item.deepLinkStatus === 'verified') return '可归因深链';
  if (isExternalSearchEntry(item) || item.matchLevel === 'generic' || item.linkKind === 'search') return '外部搜索入口';
  return item.provider || '外部服务';
}

export function predictionAverage(summary) {
  const value = summary?.averagePredictionScore ?? summary?.averagePrediction ?? summary?.averageTrust;
  return value !== null && value !== '' && Number.isFinite(Number(value)) ? Math.round(Number(value)) : '待计算';
}

export function sourceEvidencePrediction(item) {
  const value = item?.predictionScore ?? item?.trustScore;
  return value !== null && value !== '' && Number.isFinite(Number(value)) ? Math.round(Number(value)) : '待计算';
}

export function safeReadClicks() {
  try {
    const profile = getProfile();
    const rows = JSON.parse(localStorage.getItem(clickStorageKey(profile.id)) ?? '[]');
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

export function buildTrustMetrics(routebook) {
  const trust = getRouteTrustPresentation(routebook);
  const feedback = routebook.feedbackSummary ?? {};
  return [
    { label: '有效到达', value: trust.sampleCount ? `${trust.sampleCount} 次` : '待验证' },
    { label: '完成率', value: trust.sampleCount ? `${Math.round(Number(feedback.completionRate) || 0)}%` : '待验证' },
    { label: '踩坑反馈', value: trust.sampleCount ? `${Math.round(Number(feedback.pitfallRate) || 0)}%` : '待验证' },
    { label: '最近验证', value: formatVerifiedDate(trust.latestVerifiedAt) }
  ];
}

export function buildRouteTrustState(trust, isTrustedCity) {
  if (!isTrustedCity) {
    return {
      tone: 'trial',
      badgeClass: 'badge-orange',
      label: '试验生成 · POI、营业信息和导航需人工复核',
      shortLabel: '试验生成',
      value: '待人工复核',
      note: '当前城市尚未进入可信范围，暂不输出数值分。'
    };
  }
  if (trust.verified) {
    return {
      tone: 'verified',
      badgeClass: 'badge-green',
      label: trust.label,
      shortLabel: '真实打卡验证',
      value: trust.scoreText,
      note: `${trust.sampleCount} 个独立身份有效样本`
    };
  }
  return {
    tone: 'prediction',
    badgeClass: 'badge-blue',
    label: trust.label,
    shortLabel: '预测可信度',
    value: '待验证',
    note: `独立有效样本 ${Math.min(trust.sampleCount, PUBLIC_TRUST_SAMPLE_THRESHOLD)}/${PUBLIC_TRUST_SAMPLE_THRESHOLD}，暂不输出验证分。`
  };
}

export function canEditRoutebook(routebook, profileId) {
  if (!routebook || !profileId) return false;
  const owned = routebook.profileId === profileId || routebook.creator?.id === profileId;
  const isDraft = (routebook.publishStatus || 'draft') === 'draft';
  const isUnsavedGeneratedDraft = Boolean(routebook.provider?.generatedAt) && !routebook.editToken;
  return owned && isDraft && (Boolean(routebook.editToken) || isUnsavedGeneratedDraft);
}

export function createDraftStop(routebook, activeDay) {
  const center = cityCenters[routebook.city] ?? { lat: 35.8617, lng: 104.1954 };
  return {
    id: makeStopId(),
    day: activeDay || routebook.days?.[0] || 'Day 1',
    time: '14:00',
    name: '',
    area: '',
    stay: '60 分钟',
    cost: '待估算',
    verify: '新增站点，需真实打卡验证',
    risk: '需复核营业时间和交通',
    score: 72,
    lat: center.lat,
    lng: center.lng,
    geoConfidence: 45,
    coordinateSystem: 'WGS84',
    coordinateSource: 'user-edit',
    coordinatePrecision: 'approximate',
    coordinateRadiusMeters: 1500,
    navigationDisabled: true
  };
}

export function coordinatesChanged(previous, next) {
  if (!previous) return true;
  return Number(previous.lat) !== Number(next?.lat) || Number(previous.lng) !== Number(next?.lng);
}

export function makeStopId() {
  if (globalThis.crypto?.randomUUID) return `stop-${globalThis.crypto.randomUUID()}`;
  return `stop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function stableStopId(value) {
  const text = String(value ?? '').trim();
  return text || makeStopId();
}

export function stopKey(value) {
  return String(value ?? '').trim();
}

export function buildEditedMetrics(stops, existingMetrics = []) {
  const avg = stops.length ? Math.round(stops.reduce((sum, stop) => sum + Number(stop.score ?? 78), 0) / stops.length) : 78;
  const lowGeo = stops.filter((stop) => Number(stop.geoConfidence ?? 0) < 60).length;
  const budget = stops.reduce((sum, stop) => sum + (Number(String(stop.cost ?? '').match(/\d+/)?.[0]) || 0), 0);
  const calculated = [
    { label: '站点预测均分', value: `${avg}` },
    { label: '定位待复核', value: lowGeo ? `${lowGeo} 处` : '0 处' },
    { label: '预算估算', value: budget ? `约 ${budget} 元` : '待验证' },
    { label: '平均修改', value: '本次已编辑' }
  ];
  return [...calculated, ...(existingMetrics ?? []).filter((item) => !calculated.some((next) => next.label === item.label))].slice(0, 6);
}

export function buildEditedValidations(stops, existingValidations = [], reason = '编辑') {
  const dayCounts = stops.reduce((acc, stop) => {
    const day = stop.day || 'Day 1';
    acc[day] = (acc[day] ?? 0) + 1;
    return acc;
  }, {});
  const dense = Object.entries(dayCounts).find(([, count]) => count > 6);
  const lowGeo = stops.filter((stop) => Number(stop.geoConfidence ?? 0) < 60).length;
  const longestLeg = longestRouteLeg(stops);
  const calculated = [
    { id: 'client-edit-route', label: `${reason || '编辑'}后动线`, state: '已更新', detail: '已重新计算站点顺序、天数分组和地图连线。' },
    {
      id: 'client-edit-density',
      label: '节奏密度',
      state: dense ? '偏紧' : '可执行',
      detail: dense ? `${dense[0]} 有 ${dense[1]} 站，建议继续删减或拆天。` : '单日站点密度在可执行范围内。'
    },
    {
      id: 'client-edit-geo',
      label: '定位复核',
      state: lowGeo ? '需复核' : '通过',
      detail: lowGeo ? `${lowGeo} 个站点坐标置信度偏低。` : '当前站点坐标可用于地图展示。'
    },
    {
      id: 'client-edit-leg',
      label: '转场距离',
      state: longestLeg > 12000 ? '偏远' : longestLeg > 6000 ? '需留缓冲' : '可执行',
      detail: longestLeg ? `最长相邻转场约 ${(longestLeg / 1000).toFixed(1)} km，建议结合真实交通复核。` : '站点距离信息不足，建议补充坐标。'
    },
    {
      id: 'client-edit-ai-stale',
      label: 'AI 校验状态',
      state: '需复核',
      detail: '路线已被人工编辑，旧模型校验只作参考；分享前建议重新保存并按实际日期复核开放时间。'
    }
  ];
  const staleIds = new Set(['hours', 'walk', 'budget', 'crowd']);
  return [...calculated, ...(existingValidations ?? []).filter((item) => !calculated.some((next) => next.id === item.id) && !staleIds.has(item.id))].slice(
    0,
    8
  );
}

export function longestRouteLeg(stops) {
  let longest = 0;
  for (let index = 0; index < stops.length - 1; index += 1) {
    const current = stops[index];
    const next = stops[index + 1];
    if (current.day !== next.day) continue;
    const distance = distanceMeters(current, next);
    if (distance > longest) longest = distance;
  }
  return longest;
}

export function distanceMeters(a, b) {
  const lat1 = Number(a?.lat);
  const lng1 = Number(a?.lng);
  const lat2 = Number(b?.lat);
  const lng2 = Number(b?.lng);
  if (!isValidCoordinate(lat1, lng1) || !isValidCoordinate(lat2, lng2)) return 0;
  const toRad = (value) => (value * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function calculateLocalTrustScore(stops) {
  if (!stops.length) return 60;
  const avg = stops.reduce((sum, stop) => sum + Number(stop.score ?? 78), 0) / stops.length;
  const lowGeoPenalty = stops.filter((stop) => Number(stop.geoConfidence ?? 0) < 60).length * 3;
  const missingCostPenalty = stops.filter((stop) => !/\d/.test(String(stop.cost ?? ''))).length * 1.5;
  return Math.round(Math.max(45, Math.min(96, avg - lowGeoPenalty - missingCostPenalty)));
}

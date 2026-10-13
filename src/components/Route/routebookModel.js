// Pure routebook helpers used by the route page (editing, metrics, trust state).
// Extracted verbatim from the former monolithic RouteView.jsx.
import { cityCenters, isValidCoordinate } from '../../lib/coordinates';
import { clickStorageKey, safeWriteJsonStorage } from '../../lib/storage';
import { getProfile } from '../../lib/profile';
import { isExternalSearchEntry } from '../../lib/products';
import { PUBLIC_TRUST_SAMPLE_THRESHOLD, formatVerifiedDate, getRouteTrustPresentation } from '../../lib/trust';
import { coordinateVerificationLevel, routeEvidenceScore } from '../../lib/trustSignals';
import { sumStopCosts } from '../../lib/cost';

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

// GET 请求可能在用户编辑期间返回。只比较可编辑/路线内容，不把版本、时间戳和
// 服务端聚合字段算作分叉，避免一次普通刷新被误判为冲突。
export function hasRoutebookContentDifference(left, right) {
  if (!left || !right) return false;
  return routebookContentFingerprint(left) !== routebookContentFingerprint(right);
}

// 回调时从 localStorage 和 React ref 取到多个候选版本时，脏编辑优先；其余再按
// editedAt/updatedAt/version 选最新。这样 GET 等待期间的内存编辑不会被起始快照遮蔽。
export function selectLatestLocalRoutebook(candidates, profileId, routeId = '') {
  const targetId = String(routeId || '').trim();
  const eligible = (Array.isArray(candidates) ? candidates : []).filter((book) => {
    if (!book) return false;
    const id = String(book.publicId || book.id || '').trim();
    if (targetId && id !== targetId) return false;
    return book.profileId === profileId || book.creator?.id === profileId;
  });
  if (!eligible.length) return null;
  return eligible.slice(1).reduce((best, candidate) => (compareLocalRoutebookSnapshots(candidate, best) > 0 ? candidate : best), eligible[0]);
}

// 判断 GET 返回是否会静默覆盖本地编辑。contentDiverged 同时覆盖“远端版本领先”
// 和“同版本但 GET 等待中发生编辑”两种竞态；调用方据此先保留两个可恢复副本。
export function routebookRefreshDecision(remote, local, profileId) {
  const remoteId = String(remote?.publicId || remote?.id || '').trim();
  const localId = String(local?.publicId || local?.id || '').trim();
  const sameRoute = Boolean(remoteId && localId && remoteId === localId);
  const localOwned = Boolean(local && (local.profileId === profileId || local.creator?.id === profileId));
  const localDirty = hasUnsyncedLocalEdits(local);
  const contentDiverged = sameRoute && hasRoutebookContentDifference(remote, local);
  const remoteVersion = currentRoutebookVersion(remote);
  const localVersion = currentRoutebookVersion(local);
  const versionDiverged = remoteVersion != null && localVersion != null && remoteVersion !== localVersion;
  const preserveLocal = Boolean(sameRoute && localOwned && localDirty && contentDiverged);
  return {
    sameRoute,
    localOwned,
    localDirty,
    contentDiverged,
    versionDiverged,
    remoteVersion,
    localVersion,
    preserveLocal,
    reason: preserveLocal ? (versionDiverged ? 'local-dirty-remote-version' : 'local-dirty-refresh-race') : ''
  };
}

export function routebookRefreshConflictKey(remote, local) {
  return [
    String(remote?.publicId || remote?.id || ''),
    currentRoutebookVersion(remote) ?? '',
    currentRoutebookVersion(local) ?? '',
    remote?.updatedAt ?? '',
    local?.updatedAt ?? '',
    remote?.provider?.editedAt ?? '',
    local?.provider?.editedAt ?? '',
    routebookContentFingerprint(remote),
    routebookContentFingerprint(local)
  ].join('|');
}

function compareLocalRoutebookSnapshots(left, right) {
  const leftDirty = hasUnsyncedLocalEdits(left);
  const rightDirty = hasUnsyncedLocalEdits(right);
  if (leftDirty !== rightDirty) return leftDirty ? 1 : -1;
  const leftTimestamp = routebookSnapshotTimestamp(left);
  const rightTimestamp = routebookSnapshotTimestamp(right);
  if (leftTimestamp !== rightTimestamp) return leftTimestamp - rightTimestamp;
  return (currentRoutebookVersion(left) ?? -1) - (currentRoutebookVersion(right) ?? -1);
}

function routebookSnapshotTimestamp(routebook) {
  const timestamps = [routebook?.provider?.editedAt, routebook?.updatedAt, routebook?.provider?.generatedAt, routebook?.createdAt]
    .map((value) => Date.parse(value ?? ''))
    .filter(Number.isFinite);
  return timestamps.length ? Math.max(...timestamps) : 0;
}

function routebookContentFingerprint(routebook) {
  return JSON.stringify(
    canonicalizeRoutebookValue({
      city: routebook?.city,
      title: routebook?.title,
      summary: routebook?.summary,
      days: routebook?.days,
      stops: routebook?.stops,
      variants: routebook?.variants,
      activeVariantId: routebook?.activeVariantId,
      constraints: routebook?.constraints,
      routeLegs: routebook?.routeLegs,
      importedSources: routebook?.importedSources
    })
  );
}

function canonicalizeRoutebookValue(value) {
  if (Array.isArray(value)) return value.map(canonicalizeRoutebookValue);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value)
    .sort()
    .reduce((result, key) => {
      result[key] = canonicalizeRoutebookValue(value[key]);
      return result;
    }, {});
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
  if (item.deepLinkStatus === 'verified') return '直达链接';
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
      label: 'AI 草稿 · 地点、营业时间和导航都未实地确认',
      shortLabel: 'AI 草稿',
      value: '待人工复核',
      note: '这座城市还没开放可信评分，先不打分。'
    };
  }
  if (trust.verified) {
    return {
      tone: 'verified',
      badgeClass: 'badge-green',
      label: trust.label,
      shortLabel: '真实打卡验证',
      value: trust.scoreText,
      note: `${trust.sampleCount} 个人有效打卡`
    };
  }
  return {
    tone: 'prediction',
    badgeClass: 'badge-blue',
    label: trust.label,
    shortLabel: '资料核验',
    value: '待验证',
    note: `已有 ${Math.min(trust.sampleCount, PUBLIC_TRUST_SAMPLE_THRESHOLD)}/${PUBLIC_TRUST_SAMPLE_THRESHOLD} 个人有效打卡，够数后再打分。`
  };
}

export function canEditRoutebook(routebook, profileId) {
  if (!routebook || !profileId) return false;
  const owned = routebook.profileId === profileId || routebook.creator?.id === profileId;
  const isDraft = (routebook.publishStatus || 'draft') === 'draft';
  const isUnsavedGeneratedDraft = Boolean(routebook.provider?.generatedAt) && !routebook.editToken;
  return owned && isDraft && (Boolean(routebook.editToken) || routebook.ownerAccessVerified === true || isUnsavedGeneratedDraft);
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
    provenance: { origin: 'user-added', name: '' },
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
  const evidence = routeEvidenceScore(stops);
  const lowGeo = stops.filter((stop) => coordinateVerificationLevel(stop) !== 'verified').length;
  const budget = sumStopCosts(stops);
  const budgetText = !budget.knownCount
    ? '待补充'
    : `约 ${budget.min === budget.max ? budget.min : `${budget.min}–${budget.max}`} 元${budget.unknownCount ? `（另有 ${budget.unknownCount} 处待补充）` : ''}`;
  const calculated = [
    { label: '实际路程', value: '改动的路段还没重新查' },
    { label: '道路距离', value: '还没按导航查' },
    { label: '道路耗时', value: '还没按导航查' },
    { label: '资料核验分', value: evidence.score == null ? '—' : `${evidence.score}` },
    { label: '定位待复核', value: lowGeo ? `${lowGeo} 处` : '0 处' },
    { label: '预算估算', value: budgetText }
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
      state: dense ? '偏紧' : '路程还没查',
      detail: dense ? `${dense[0]} 有 ${dense[1]} 站，建议继续删减或拆天。` : '站点密度正常；道路耗时已失效，需重新核验后判断可达性。'
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
      state: '路程还没查',
      detail: longestLeg ? `最长相邻直线约 ${(longestLeg / 1000).toFixed(1)} km，不代表真实道路距离或耗时。` : '站点距离信息不足，建议补充坐标。'
    },
    {
      id: 'client-edit-ai-stale',
      label: 'AI 校验状态',
      state: '需复核',
      detail: '路线已被人工编辑，旧模型校验只作参考；分享前建议重新保存并按实际日期复核开放时间。'
    }
  ];
  const staleIds = new Set(['hours', 'walk', 'budget', 'crowd', 'edit-routing', 'edit-tempo', 'edit-detour']);
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

/** Local (pre-save) evidence score; the server recomputes it from the catalog on save. */
export function calculateLocalTrustScore(stops) {
  return routeEvidenceScore(stops).score ?? 0;
}

const DETOUR_DISTANCE_METERS = 8000;
const DETOUR_DURATION_SECONDS = 60 * 60;

export function summarizeRouteExecution(stops = [], routeLegs = []) {
  const pairs = adjacentSameDayPairs(Array.isArray(stops) ? stops : []);
  const legsByPair = new Map();
  for (const leg of Array.isArray(routeLegs) ? routeLegs : []) {
    const key = pairKey(leg?.fromStopId, leg?.toStopId);
    if (!key) continue;
    const candidates = legsByPair.get(key) ?? [];
    candidates.push(leg);
    legsByPair.set(key, candidates);
  }

  let verifiedLegs = 0;
  let unverifiedLegs = 0;
  let totalDistanceMeters = 0;
  let totalDurationSeconds = 0;
  let longestDistanceMeters = 0;
  let longestDurationSeconds = 0;
  let unknownScheduleLegs = 0;
  const riskyLegs = [];
  const scheduleConflicts = [];

  for (const pair of pairs) {
    const key = pairKey(pair.from?.id, pair.to?.id);
    const candidates = key ? (legsByPair.get(key) ?? []) : [];
    const leg = candidates.shift();
    if (!isVerifiedRoadLeg(leg, pair.from, pair.to)) {
      unverifiedLegs += 1;
      continue;
    }

    verifiedLegs += 1;
    const distanceMeters = Number(leg.distanceMeters);
    const durationSeconds = Number(leg.durationSeconds);
    totalDistanceMeters += distanceMeters;
    totalDurationSeconds += durationSeconds;
    longestDistanceMeters = Math.max(longestDistanceMeters, distanceMeters);
    longestDurationSeconds = Math.max(longestDurationSeconds, durationSeconds);

    if (distanceMeters > DETOUR_DISTANCE_METERS || durationSeconds > DETOUR_DURATION_SECONDS) {
      riskyLegs.push({
        from: displayStopName(pair.from),
        to: displayStopName(pair.to),
        distanceMeters,
        durationSeconds,
        mode: String(leg.mode || 'unknown').slice(0, 24)
      });
    }

    const currentStart = parseTimeOfDayMinutes(pair.from?.time);
    const nextStart = parseTimeOfDayMinutes(pair.to?.time);
    const stayMinutes = parseStayMinutes(pair.from?.stay);
    if (currentStart == null || nextStart == null || stayMinutes == null) {
      unknownScheduleLegs += 1;
      continue;
    }
    const transferMinutes = Math.ceil(durationSeconds / 60);
    const availableTransferMinutes = nextStart - currentStart - stayMinutes;
    if (availableTransferMinutes < transferMinutes) {
      scheduleConflicts.push({
        from: displayStopName(pair.from),
        to: displayStopName(pair.to),
        availableMinutes: Math.max(0, availableTransferMinutes),
        requiredMinutes: transferMinutes,
        shortfallMinutes: transferMinutes - availableTransferMinutes
      });
    }
  }

  return {
    expectedLegs: pairs.length,
    verifiedLegs,
    unverifiedLegs,
    allVerified: pairs.length > 0 && verifiedLegs === pairs.length,
    totalDistanceMeters,
    totalDurationSeconds,
    longestDistanceMeters,
    longestDurationSeconds,
    unknownScheduleLegs,
    riskyLegs,
    scheduleConflicts
  };
}

export function routeExecutionMetricRows(stats = {}) {
  const expectedLegs = nonNegativeInteger(stats.expectedLegs);
  const verifiedLegs = nonNegativeInteger(stats.verifiedLegs);
  if (!expectedLegs) {
    return [
      { label: '道路核验', value: '无同日转场' },
      { label: '道路距离', value: '无需计算' },
      { label: '道路耗时', value: '无需计算' }
    ];
  }
  const complete = verifiedLegs === expectedLegs;
  const suffix = complete ? '' : `（${verifiedLegs}/${expectedLegs} 段）`;
  return [
    { label: '道路核验', value: complete ? `${verifiedLegs}/${expectedLegs} 段已核验` : `${verifiedLegs}/${expectedLegs} 段，待复核` },
    {
      label: '道路距离',
      value: verifiedLegs ? `${complete ? '约 ' : '已核验 '}${formatDistance(stats.totalDistanceMeters)}${suffix}` : '待道路服务核验'
    },
    {
      label: '道路耗时',
      value: verifiedLegs ? `${complete ? '约 ' : '已核验 '}${formatDuration(stats.totalDurationSeconds)}${suffix}` : '待道路服务核验'
    }
  ];
}

export function routeExecutionValidationRows(stats = {}, { reason = '保存', crowdedDay = null, missingCoordinate = 0 } = {}) {
  const expectedLegs = nonNegativeInteger(stats.expectedLegs);
  const verifiedLegs = nonNegativeInteger(stats.verifiedLegs);
  const unverifiedLegs = Math.max(0, expectedLegs - verifiedLegs);
  const allVerified = expectedLegs > 0 && verifiedLegs === expectedLegs;
  const firstConflict = stats.scheduleConflicts?.[0];
  const firstRisk = stats.riskyLegs?.[0];

  let routingState = '无需核验';
  let routingDetail = `${reason}后没有同日相邻转场。`;
  if (expectedLegs) {
    routingState = allVerified && !missingCoordinate ? '已核验' : '需复核';
    routingDetail =
      allVerified && !missingCoordinate
        ? `${reason}后已按道路结果核验 ${verifiedLegs} 段，合计约 ${formatDistance(stats.totalDistanceMeters)}、${formatDuration(stats.totalDurationSeconds)}。`
        : `${reason}后仅 ${verifiedLegs}/${expectedLegs} 段取得可信道路结果；${missingCoordinate ? `${missingCoordinate} 个站点缺少可用坐标，` : ''}${unverifiedLegs} 段无法判断真实距离与耗时。`;
  }

  let tempoState = '无需判断';
  let tempoDetail = '没有同日连续转场，无需判断道路节奏。';
  if (firstConflict) {
    tempoState = '时间冲突';
    tempoDetail = `${firstConflict.from} → ${firstConflict.to} 仅预留 ${firstConflict.availableMinutes} 分钟转场，道路核验需 ${firstConflict.requiredMinutes} 分钟，至少再预留 ${firstConflict.shortfallMinutes} 分钟。`;
  } else if (crowdedDay) {
    tempoState = '偏紧';
    tempoDetail = `${crowdedDay[0]} 有 ${crowdedDay[1]} 站，建议拆分或删减。`;
  } else if (expectedLegs && !allVerified) {
    tempoState = '待复核';
    tempoDetail = `${unverifiedLegs} 段没有可信道路耗时，当前不能判断行程是否可执行。`;
  } else if (allVerified && Number(stats.unknownScheduleLegs) > 0) {
    tempoState = '待补充';
    tempoDetail = `${stats.unknownScheduleLegs} 段缺少规范到达时间或停留时长，暂不能完成时间可达性判断。`;
  } else if (allVerified) {
    tempoState = '可执行';
    tempoDetail = `已用 ${verifiedLegs} 段道路耗时校验相邻站点时间，未发现到达时间冲突。`;
  }

  let detourState = '无需判断';
  let detourDetail = '没有同日连续转场，无需判断绕路风险。';
  if (firstRisk) {
    detourState = '需重排';
    detourDetail = `${firstRisk.from} → ${firstRisk.to} 道路约 ${formatDistance(firstRisk.distanceMeters)}、${formatDuration(firstRisk.durationSeconds)}，建议拆天或替换同区 POI。`;
  } else if (expectedLegs && !allVerified) {
    detourState = '待复核';
    detourDetail = `${unverifiedLegs} 段没有可信道路距离或耗时，暂不能排除绕路风险。`;
  } else if (allVerified) {
    detourState = '可执行';
    detourDetail = `最长相邻道路转场约 ${formatDistance(stats.longestDistanceMeters)}、${formatDuration(stats.longestDurationSeconds)}。`;
  }

  return [
    { id: 'edit-routing', label: '编辑后动线', state: routingState, detail: routingDetail },
    { id: 'edit-tempo', label: '节奏密度', state: tempoState, detail: tempoDetail },
    { id: 'edit-detour', label: '绕路风险', state: detourState, detail: detourDetail }
  ];
}

function adjacentSameDayPairs(stops) {
  const pairs = [];
  for (let index = 0; index < stops.length - 1; index += 1) {
    const from = stops[index];
    const to = stops[index + 1];
    if ((from?.day || 'Day 1') !== (to?.day || 'Day 1')) continue;
    pairs.push({ from, to });
  }
  return pairs;
}

function isVerifiedRoadLeg(leg, from, to) {
  return (
    leg?.status === 'verified' &&
    sameStopId(leg?.fromStopId, from?.id) &&
    sameStopId(leg?.toStopId, to?.id) &&
    finiteNonNegative(leg?.distanceMeters) &&
    finiteNonNegative(leg?.durationSeconds)
  );
}

function finiteNonNegative(value) {
  if (value == null || (typeof value === 'string' && !value.trim())) return false;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0;
}

function pairKey(fromStopId, toStopId) {
  if (!hasStopId(fromStopId) || !hasStopId(toStopId)) return '';
  return `${String(fromStopId)}\u0000${String(toStopId)}`;
}

function hasStopId(value) {
  return (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value.trim() !== '');
}

function sameStopId(left, right) {
  return hasStopId(left) && hasStopId(right) && String(left) === String(right);
}

function parseTimeOfDayMinutes(value) {
  const match = String(value ?? '').match(/^(?:[^\d]*)(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

function parseStayMinutes(value) {
  const text = String(value ?? '');
  const hourMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:小时|h)/i);
  const minuteMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:分钟|分|min)/i);
  if (!hourMatch && !minuteMatch) return null;
  const minutes = (hourMatch ? Number(hourMatch[1]) * 60 : 0) + (minuteMatch ? Number(minuteMatch[1]) : 0);
  return Number.isFinite(minutes) ? Math.max(0, Math.min(12 * 60, Math.round(minutes))) : null;
}

function formatDistance(value) {
  const meters = Number(value);
  if (!Number.isFinite(meters) || meters < 0) return '待复核';
  return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(1)} km`;
}

function formatDuration(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return '待复核';
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} 小时 ${remainder} 分钟` : `${hours} 小时`;
}

function displayStopName(stop) {
  return String(stop?.name || stop?.id || '未命名站点').slice(0, 48);
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
}

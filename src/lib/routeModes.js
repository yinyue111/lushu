import { coordinateForName, distanceKm } from './coordinates.js';

// 「一键重排」与路线变体共享的模式重排逻辑。RouteView（行前编辑）与
// TripView（行中剩余站点重排）都从这里取同一套权重，避免两份实现漂移。
export const ROUTE_MODES = ['少走路', '雨天', '低预算', '亲子'];

export function modeSlug(mode) {
  const slugs = {
    少走路: 'less-walk',
    雨天: 'rainy',
    低预算: 'budget',
    亲子: 'family'
  };
  return slugs[mode] ?? 'custom';
}

export function variantSummary(mode) {
  const summaries = {
    少走路: '按区域聚合站点，减少跨区折返，适合老人、亲子和低体力行程。',
    雨天: '优先室内、展馆和商场点位，保留正餐时段，降低天气对执行的影响。',
    低预算: '按费用从低到高重排，优先免费/低消费点位，保留正餐时段并提示预算复核。',
    亲子: '优先公园、展馆、湖边和商场等停留缓冲更强的点位。'
  };
  return summaries[mode] ?? `按${mode}偏好生成可切换路线。`;
}

export function indoorWeight(stop) {
  return /馆|展|店|餐|咖啡|茶|商场|寺|室内|书店|剧场/.test(`${stop?.name ?? ''}${stop?.area ?? ''}${stop?.risk ?? ''}`) ? 2 : 0;
}

export function costWeight(stop) {
  const match = String(stop?.cost ?? '').match(/\d+/);
  return Number(match?.[0] ?? 0);
}

export function familyWeight(stop) {
  return /园|馆|湖|街|商场|公园/.test(`${stop?.name ?? ''}${stop?.area ?? ''}`) ? 2 : 0;
}

const MEAL_KEYWORD_RE = /早餐|早饭|午餐|午饭|晚餐|晚饭|正餐|餐厅|饭店|菜馆|酒楼|面馆|火锅|本帮菜|杭帮菜|苏帮菜|淮扬菜|大牌档|生煎|小笼|锅贴|素菜馆/;
const NON_MEAL_VENUE_RE = /博物馆|博物院|美术馆|纪念馆|展览馆|书店|公馆|会馆/;

function parseStartMinutes(timeText) {
  const m = /^\s*(\d{1,2}):(\d{2})/.exec(String(timeText ?? ''));
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  return hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59 ? hh * 60 + mm : null;
}

/**
 * 判断站点是否是已排在午/晚餐时间带的正餐站点：一键重排时固定在原饭点槽位，
 * 避免「雨天」把晚饭挪到清早 09:30 或「低预算」把午饭挤到深夜。
 */
export function isScheduledMealStop(stop) {
  const startMin = parseStartMinutes(stop?.time);
  if (startMin == null) return false;
  const inLunchOrDinner = (startMin >= 11 * 60 && startMin <= 14 * 60 + 15) || (startMin >= 17 * 60 && startMin <= 21 * 60);
  if (!inLunchOrDinner) return false;
  const nameAndNote = `${stop?.name ?? ''} ${stop?.verify ?? ''}`;
  if (NON_MEAL_VENUE_RE.test(String(stop?.name ?? ''))) return false;
  return stop?.costInfo?.unit === 'meal' || MEAL_KEYWORD_RE.test(nameAndNote);
}

// 贪心最近邻：从锚点出发依次挑选综合代价最低的下一站。
// 代价 = 距离（或区域惩罚兜底）+ 模式偏好项，保证同区聚合的同时尊重模式意图。
export function greedyModeOrder(sourceStops, initialAnchor, mode, { endAnchor = null } = {}) {
  const remaining = [...sourceStops];
  const ordered = [];
  let anchor = initialAnchor;
  while (remaining.length) {
    let bestIndex = 0;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      const distance = anchor ? distanceKm(anchor, candidate) : null;
      const areaPenalty = anchor?.area && candidate.area === anchor.area ? 0 : 4;
      const distancePenalty = Number.isFinite(distance) ? distance : areaPenalty + index;
      let modePenalty = 0;
      if (mode === '雨天') modePenalty = indoorWeight(candidate) ? -20 : 12;
      else if (mode === '低预算') modePenalty = costWeight(candidate) * 0.1;
      else if (mode === '亲子') modePenalty = familyWeight(candidate) ? -6 : 6;
      // 末日配置返程站时，先逛离返程站较远的点，把靠近返程站的点留作最后一站。
      let endBias = 0;
      if (endAnchor && remaining.length > 1) {
        const distToEnd = distanceKm(candidate, endAnchor);
        if (Number.isFinite(distToEnd)) endBias = -0.25 * distToEnd;
      }
      const score = distancePenalty + areaPenalty + modePenalty + endBias;
      if (score < bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    const [next] = remaining.splice(bestIndex, 1);
    ordered.push(next);
    anchor = next;
  }
  return ordered;
}

export function orderedDays(stops = [], preferredDays = []) {
  const daySet = new Set(stops.map((stop) => stop.day || 'Day 1'));
  return [...(preferredDays ?? []).filter((day) => daySet.has(day)), ...[...daySet].filter((day) => !(preferredDays ?? []).includes(day))];
}

function hubAnchor(hubName, city) {
  const name = String(hubName ?? '').trim();
  if (!name) return null;
  const coord = coordinateForName(name, city);
  if (!coord) return null;
  return { name, lat: coord.lat, lng: coord.lng, geoConfidence: 90 };
}

// 全路线重排：逐日应用贪心最近邻，保留已排好饭点的正餐槽位，并以首末日车站为起止锚点。
export function reorderStopsByMode(stops, mode, { preferredDays = [], anchorStop = null, constraints = null, city = '' } = {}) {
  const source = Array.isArray(stops) ? stops : [];
  const days = orderedDays(source, preferredDays);
  const arrivalAnchor = hubAnchor(constraints?.arrivalHub, city);
  const departureAnchor = hubAnchor(constraints?.departureHub, city);
  let anchor = anchorStop ?? arrivalAnchor;
  const ordered = [];
  days.forEach((day, dayIdx) => {
    const dayStops = source.filter((stop) => (stop.day || 'Day 1') === day);
    const isLastDay = dayIdx === days.length - 1;
    const pinnedSlots = new Map();
    const movable = [];
    dayStops.forEach((stop, pos) => {
      if (isScheduledMealStop(stop)) pinnedSlots.set(pos, stop);
      else movable.push(stop);
    });
    if (!pinnedSlots.size) {
      const reordered = greedyModeOrder(dayStops, anchor, mode, { endAnchor: isLastDay ? departureAnchor : null });
      ordered.push(...reordered);
      anchor = reordered.at(-1) ?? anchor;
      return;
    }
    const reorderedMovable = greedyModeOrder(movable, anchor, mode, { endAnchor: isLastDay ? departureAnchor : null });
    let movableCursor = 0;
    const mergedDay = [];
    for (let pos = 0; pos < dayStops.length; pos += 1) {
      if (pinnedSlots.has(pos)) {
        mergedDay.push(pinnedSlots.get(pos));
      } else if (movableCursor < reorderedMovable.length) {
        mergedDay.push(reorderedMovable[movableCursor++]);
      }
    }
    ordered.push(...mergedDay);
    anchor = mergedDay.at(-1) ?? anchor;
  });
  return ordered;
}

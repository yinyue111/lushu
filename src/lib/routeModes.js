import { distanceKm } from './coordinates';

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
    雨天: '优先室内、餐饮、展馆和商场点位，降低天气对执行的影响。',
    低预算: '按费用从低到高重排，优先免费/低消费点位，并提示预算复核。',
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

// 贪心最近邻：从锚点出发依次挑选综合代价最低的下一站。
// 代价 = 距离（或区域惩罚兜底）+ 模式偏好项，保证同区聚合的同时尊重模式意图。
export function greedyModeOrder(sourceStops, initialAnchor, mode) {
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
      const score = distancePenalty + areaPenalty + modePenalty;
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
  return [
    ...(preferredDays ?? []).filter((day) => daySet.has(day)),
    ...[...daySet].filter((day) => !(preferredDays ?? []).includes(day))
  ];
}

// 全路线重排：逐日应用贪心最近邻，前一日末站作为次日锚点。
export function reorderStopsByMode(stops, mode, { preferredDays = [], anchorStop = null } = {}) {
  const source = Array.isArray(stops) ? stops : [];
  let anchor = anchorStop;
  const ordered = [];
  for (const day of orderedDays(source, preferredDays)) {
    const dayStops = source.filter((stop) => (stop.day || 'Day 1') === day);
    const reordered = greedyModeOrder(dayStops, anchor, mode);
    ordered.push(...reordered);
    anchor = reordered.at(-1) ?? anchor;
  }
  return ordered;
}

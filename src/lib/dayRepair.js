// 「某天 0 站」的统一修复，生成、局部调整、删除/合并天、保存都走这里。
// 原则：只移动已有站点（保持顺序）；站点不够就缩短天数并写明原因；绝不补站。

const DAY_LABEL = /^Day\s*(\d+)$/i;

/**
 * 修复「选了 N 天、某天 0 站」：模型常把全部站点标成 Day 1。
 * 只重新分配已有站点（保持模型给的顺序），绝不补站；站点太少时收缩天数并说明。
 * @returns {{ stops: any[], days: string[], validation: null | { id: string, label: string, state: string, detail: string } }}
 */
export function repairEmptyDays(stops, days) {
  const used = new Set(stops.map((stop) => stop.day));
  if (days.every((day) => used.has(day))) return { stops, days, validation: null };
  const ordered = stops
    .map((stop, order) => ({ stop, order, dayIndex: Math.max(0, days.indexOf(stop.day)) }))
    .sort((a, b) => a.dayIndex - b.dayIndex || a.order - b.order)
    .map((entry) => entry.stop);
  const dayCount = Math.min(days.length, ordered.length);
  const nextDays = days.slice(0, dayCount);
  const base = Math.floor(ordered.length / dayCount);
  const extra = ordered.length % dayCount;
  let cursor = 0;
  const nextStops = [];
  nextDays.forEach((day, index) => {
    const size = base + (index < extra ? 1 : 0);
    for (const stop of ordered.slice(cursor, cursor + size)) nextStops.push({ ...stop, day });
    cursor += size;
  });
  const shrunk = dayCount < days.length;
  return {
    stops: nextStops.map((stop, index) => ({ ...stop, id: index + 1 })),
    days: nextDays,
    validation: {
      id: 'day-count-repaired',
      label: '行程天数',
      state: shrunk ? '已缩短' : '已重新分配',
      detail: shrunk
        ? `攻略里的地点只够排 ${dayCount} 天（共 ${ordered.length} 站），没有为凑满 ${days.length} 天编造新站。`
        : `AI 把站点挤在了少数几天，已按原顺序把 ${ordered.length} 个站点分到 ${days.length} 天，各站时间请再看一眼。`
    }
  };
}

/**
 * 编辑后（删除/合并一天、AI 局部调整、去掉 AI 加的站）去掉空的天，
 * 并把「Day N」标签重新连续编号（删掉第 2 天后，第 3 天顺延为第 2 天）。
 * 自定义天名（不是 Day N 格式）原样保留，只去掉空的。
 * @returns {{ stops: any[], days: string[], removedDays: string[], validation: null | { id: string, label: string, state: string, detail: string } }}
 */
export function compactDays(stops, days = []) {
  const list = Array.isArray(stops) ? stops : [];
  const used = new Set(list.map((stop) => stop.day || 'Day 1'));
  const known = (Array.isArray(days) ? days : []).filter(Boolean);
  const ordered = [...known.filter((day) => used.has(day)), ...[...used].filter((day) => !known.includes(day))];
  const removedDays = known.filter((day) => !used.has(day));
  const allNumbered = ordered.every((day) => DAY_LABEL.test(day));
  const rename = new Map(ordered.map((day, index) => [day, allNumbered ? `Day ${index + 1}` : day]));
  const relabeled = [...rename].some(([from, to]) => from !== to);
  const nextStops = relabeled ? list.map((stop) => ({ ...stop, day: rename.get(stop.day || 'Day 1') })) : list;
  const nextDays = ordered.map((day) => rename.get(day));
  const changed = removedDays.length > 0 || relabeled;
  return {
    stops: nextStops,
    days: nextDays,
    removedDays,
    validation: changed
      ? {
          id: 'day-count-compacted',
          label: '行程天数',
          state: '已缩短',
          detail: `现在共 ${nextDays.length} 天：没有站点的那天已去掉${relabeled ? '，后面的天数依次顺延' : ''}。没有为补满天数添加新站。`
        }
      : null
  };
}

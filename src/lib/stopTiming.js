// 站点调序后时间段保持时间先后：位置决定时段，站点保留自己的停留时长。
// 只处理每站都是 "HH:MM" 或 "HH:MM-HH:MM" 的日程；解析不了就原样返回，避免编造时间。

const TIME_RANGE = /^\s*(\d{1,2}):(\d{2})\s*(?:[-–~至到]\s*(\d{1,2}):(\d{2}))?\s*$/;

function parseRange(value) {
  const match = TIME_RANGE.exec(String(value ?? ''));
  if (!match) return null;
  const start = Number(match[1]) * 60 + Number(match[2]);
  const end = match[3] == null ? null : Number(match[3]) * 60 + Number(match[4]);
  if (start >= 24 * 60 || (end != null && (end >= 24 * 60 || end < start))) return null;
  return { start, duration: end == null ? null : end - start };
}

function formatMinutes(total) {
  const minutes = Math.min(total, 23 * 60 + 59);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * Re-time the stops of the given days after a reorder: the sorted start times of that day are handed out by
 * position, each stop keeps its own duration, and a slot never starts before the previous stop ends.
 * @param {any[]} stops
 * @param {string[]} days
 * @returns {any[]}
 */
export function retimeReorderedDays(stops, days) {
  const list = Array.isArray(stops) ? stops : [];
  const next = [...list];
  for (const day of new Set(days)) {
    const indexes = list.reduce((acc, stop, index) => ((stop?.day || 'Day 1') === day ? [...acc, index] : acc), []);
    const parsed = indexes.map((index) => parseRange(list[index]?.time));
    if (indexes.length < 2 || parsed.some((item) => !item)) continue;
    const slots = parsed.map((item) => item.start).sort((a, b) => a - b);
    let previousEnd = -1;
    indexes.forEach((index, position) => {
      const { duration } = parsed[position];
      const start = Math.max(slots[position], previousEnd);
      previousEnd = duration == null ? start : start + duration;
      const time = duration == null ? formatMinutes(start) : `${formatMinutes(start)}-${formatMinutes(start + duration)}`;
      if (time !== list[index].time) next[index] = { ...list[index], time };
    });
  }
  return next;
}

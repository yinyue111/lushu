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

// 下一站建议时间倒计时：解析 stop.time 里的 HH:mm，与当前时间比较；
// 解析不到、下一站在另一天（明天的 09:00 不是“超时”），或相差超过 12 小时时不展示。
export function nextStopEta(stop, nowMs, currentStop = null) {
  if (currentStop && (stop?.day || 'Day 1') !== (currentStop?.day || 'Day 1')) return null;
  const match = String(stop?.time ?? '').match(/(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  const target = new Date(nowMs);
  target.setHours(hours, minutes, 0, 0);
  const diffMinutes = Math.round((target.getTime() - nowMs) / 60_000);
  if (Math.abs(diffMinutes) > 12 * 60) return null;
  if (diffMinutes >= 0) return { overdue: false, label: `距建议到达还有 ${diffMinutes} 分钟` };
  return { overdue: true, label: `已超出建议时间 ${Math.abs(diffMinutes)} 分钟` };
}

/**
 * 行程今天是不是「真的在走」：只有这时才拿钟点去比「晚没晚」。
 * - 设了出发日期：今天 = 出发日期 + (当前站的第几天 - 1)。
 * - 没设日期：今天在这条路线上打过卡才算。
 * 其他情况（提前预览、非出行日）不显示迟到提醒，避免「已超出 480 分钟」这类误报。
 * @param {{ travelDate?: string, day?: string, checkins?: any[], nowMs: number }} input
 */
export function isTripLiveToday({ travelDate = '', day = 'Day 1', checkins = [], nowMs }) {
  const now = new Date(nowMs);
  const sameDay = (date) => date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  const match = String(travelDate).match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (match) {
    const offset = Math.max(0, (Number(String(day).match(/(\d+)/)?.[1]) || 1) - 1);
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + offset);
    return sameDay(date);
  }
  return (checkins ?? []).some((item) => {
    const at = new Date(item?.createdAt ?? item?.time ?? '');
    return !Number.isNaN(at.getTime()) && sameDay(at);
  });
}

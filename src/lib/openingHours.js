// Structured opening hours parsed from reviewed fact text (F02 / Phase 2).
// Only text from approved, evidence-backed facts is parsed; nothing is guessed.

const TIME = String.raw`([01]?\d|2[0-4])\s*[:：]\s*([0-5]\d)`;
const RANGE = new RegExp(`${TIME}\\s*(?:-|—|–|~|～|至|到)\\s*(?:次日\\s*)?${TIME}`);
const LAST_ENTRY = new RegExp(
  `(?:${TIME}\\s*(?:停止入场|停止入园|停止售票|停止检票|截止入场|止票))|(?:(?:最晚入场|最后入场|停止入场|停止入园|停止售票|截止入场|止票)(?:时间)?\\s*[:：为]?\\s*${TIME})`
);

function hhmm(hours, minutes) {
  return `${String(Number(hours)).padStart(2, '0')}:${minutes}`;
}

export function minutesOfDay(value) {
  const match = String(value ?? '').match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes >= 0 && minutes <= 24 * 60 ? minutes : null;
}

/**
 * @param {string} text e.g. "08:00-17:00（16:30 停止入场），周一闭馆"
 * @returns {{ alwaysOpen: boolean, openTime: string, closeTime: string, lastEntryTime: string, overnight: boolean } | null}
 */
export function parseOpeningHoursText(text) {
  const value = String(text ?? '');
  if (!value.trim()) return null;
  if (/全天|24\s*小时|不打烊|全年无休/.test(value)) return { alwaysOpen: true, openTime: '', closeTime: '', lastEntryTime: '', overnight: false };
  const range = value.match(RANGE);
  if (!range) return null;
  const openTime = hhmm(range[1], range[2]);
  const closeTime = hhmm(range[3], range[4]);
  const lastEntry = value.match(LAST_ENTRY);
  const lastEntryTime = lastEntry ? hhmm(lastEntry[1] ?? lastEntry[3], lastEntry[2] ?? lastEntry[4]) : '';
  const overnight = (minutesOfDay(closeTime) ?? 0) <= (minutesOfDay(openTime) ?? 0);
  return { alwaysOpen: false, openTime, closeTime, lastEntryTime, overnight };
}

/** "60 分钟" / "1.5 小时" / "约 2 小时" / "1-2 小时" (upper bound) → minutes, or null. */
export function parseStayMinutes(text) {
  const value = String(text ?? '');
  const hours = value.match(/(\d+(?:\.\d+)?)(?:\s*[-–~至]\s*(\d+(?:\.\d+)?))?\s*(?:个)?\s*(?:小时|h\b)/i);
  if (hours) return Math.round(Number(hours[2] ?? hours[1]) * 60);
  const minutes = value.match(/(\d+)(?:\s*[-–~至]\s*(\d+))?\s*(?:分钟|min)/i);
  if (minutes) return Number(minutes[2] ?? minutes[1]);
  return null;
}

/**
 * Compare a stop's planned arrival + stay with structured hours.
 * @returns {{ status: 'ok'|'early'|'late'|'overrun'|'unknown', lastEntryKnown: boolean, detail: string }}
 */
export function checkVisitWindow(hours, arrivalTime, stayText) {
  if (hours?.alwaysOpen) return { status: 'ok', lastEntryKnown: true, detail: '全天开放' };
  const open = minutesOfDay(hours?.openTime);
  const close = minutesOfDay(hours?.closeTime);
  const arrival = minutesOfDay(
    String(arrivalTime ?? '')
      .trim()
      .replace('：', ':')
      .padStart(5, '0')
  );
  if (open == null || close == null || arrival == null || hours?.overnight) {
    return { status: 'unknown', lastEntryKnown: Boolean(hours?.lastEntryTime), detail: arrival == null ? '计划到达时间未知' : '营业时段无法比较' };
  }
  const lastEntry = minutesOfDay(hours?.lastEntryTime);
  if (arrival < open) return { status: 'early', lastEntryKnown: lastEntry != null, detail: `计划 ${arrivalTime} 到达，${hours.openTime} 才开放` };
  if (arrival >= close || (lastEntry != null && arrival > lastEntry)) {
    return {
      status: 'late',
      lastEntryKnown: lastEntry != null,
      detail:
        lastEntry != null && arrival < close
          ? `计划 ${arrivalTime} 到达，已过最晚入场 ${hours.lastEntryTime}`
          : `计划 ${arrivalTime} 到达，${hours.closeTime} 已关闭`
    };
  }
  const stay = parseStayMinutes(stayText);
  if (stay != null && arrival + stay > close) {
    return {
      status: 'overrun',
      lastEntryKnown: lastEntry != null,
      detail: `计划停留到 ${hhmm(Math.floor((arrival + stay) / 60), String((arrival + stay) % 60).padStart(2, '0'))}，超过 ${hours.closeTime} 闭馆`
    };
  }
  return { status: 'ok', lastEntryKnown: lastEntry != null, detail: '' };
}

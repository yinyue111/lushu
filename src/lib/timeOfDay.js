// Time-of-day plausibility check for planned stops (shared by server normalization & client edits).
const NIGHT_HINT = /夜景|夜游|夜市|晚风|夜场|酒吧|灯光秀/;
const SUNSET_HINT = /日落|夕阳|黄昏|落日/;
const MORNING_HINT = /日出|早市|早茶|晨练|早点/;
const DAYTIME_VENUE = /博物馆|美术馆|博物院|纪念馆|植物园|动物园/;

function parseArrivalMinutes(timeText) {
  const match = String(timeText ?? '').match(/(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return hour * 60 + minute;
}

/**
 * Flags stops whose scheduled arrival hour clearly mismatches the place's time-of-day character.
 * @param {any[]} [stops]
 * @returns {{ id: string, label: string, state: string, detail: string } | null}
 */
export function buildTimeOfDayValidation(stops = []) {
  const list = Array.isArray(stops) ? stops : [];
  const issues = [];
  for (const stop of list) {
    const name = String(stop?.name ?? '').trim();
    if (!name) continue;
    const minutes = parseArrivalMinutes(stop?.time);
    if (minutes == null) continue;
    const day = String(stop?.day || 'Day 1').trim();
    if (NIGHT_HINT.test(name) && minutes < 17 * 60) {
      issues.push(`${day}「${name}」排在 ${stop.time}，更适合傍晚或夜间前往`);
    } else if (SUNSET_HINT.test(name) && (minutes < 15 * 60 || minutes >= 20 * 60)) {
      issues.push(`${day}「${name}」排在 ${stop.time}，建议核对当日日落时间`);
    } else if (MORNING_HINT.test(name) && minutes >= 12 * 60) {
      issues.push(`${day}「${name}」排在 ${stop.time}，通常更适合上午前往`);
    } else if (DAYTIME_VENUE.test(name) && minutes >= 19 * 60 + 30) {
      issues.push(`${day}「${name}」排在 ${stop.time}，场馆晚间通常已闭馆`);
    }
  }
  if (!issues.length) return null;
  const first = issues[0];
  const more = issues.length > 1 ? `；另有 ${issues.length - 1} 处时段待确认` : '';
  return {
    id: 'edit-time-of-day',
    label: '游览时段',
    state: '待核对',
    detail: `${first}${more}，出发前看一眼是否合适。`
  };
}

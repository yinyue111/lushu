// 「替你查好」行前助手：根据出行日期自动推算每天星期几、排查闭馆日冲突、提炼预约提前量与系统已自动核对项。
import { roadSummary } from './routeRoads.js';
import { COST_UNITS, stopCostInfo } from './cost.js';

export function summarizeCostByCategory(stops = []) {
  const buckets = new Map();
  for (const stop of Array.isArray(stops) ? stops : []) {
    const info = stop?.verifiedPrice?.costInfo?.known ? stop.verifiedPrice.costInfo : stopCostInfo(stop);
    if (!info?.known || info.free || !(info.max > 0)) continue;
    const unitKey = Object.hasOwn(COST_UNITS, info.unit) ? info.unit : 'other';
    const prev = buckets.get(unitKey) || { unit: unitKey, label: COST_UNITS[unitKey] || '其他', min: 0, max: 0, count: 0 };
    buckets.set(unitKey, {
      ...prev,
      min: Math.round((prev.min + (info.min ?? 0)) * 100) / 100,
      max: Math.round((prev.max + (info.max ?? 0)) * 100) / 100,
      count: prev.count + 1
    });
  }
  const order = ['ticket', 'meal', 'transport', 'experience', 'other'];
  const categories = order.filter((k) => buckets.has(k)).map((k) => buckets.get(k));
  const text = categories.map((c) => `${c.label} ${c.min === c.max ? `约 ${c.min} 元` : `${c.min}–${c.max} 元`}`).join(' · ');
  return { categories, text };
}

const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const CN_WEEKDAY_TO_INDEX = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };

// 常见博物馆/展馆及重点历史场馆在未写明时的默认周一闭馆特征（仅对明确属于公立场馆且未写全年无休的站点补充提示）。
const KNOWN_MONDAY_CLOSED_RE = /(博物院|博物馆|美术馆|纪念馆|科技馆|艺术馆)$/;
const KNOWN_MONDAY_CLOSED_NAMES = new Set(['南京总统府', '总统府', '中山陵', '侵华日军南京大屠杀遇难同胞纪念馆', '中共一大会址', '四行仓库抗战纪念馆']);
const KNOWN_RESERVATION_LEAD_DAYS = new Map([
  ['南京博物院', 7],
  ['苏州博物馆', 7],
  ['上海博物馆', 7],
  ['拙政园', 7],
  ['留园', 7],
  ['中山陵', 7],
  ['总统府', 7],
  ['侵华日军南京大屠杀遇难同胞纪念馆', 7],
  ['浙江美术馆', 3],
  ['中国丝绸博物馆', 5],
  ['扬州中国大运河博物馆', 7]
]);
const ALWAYS_OPEN_OVERRIDE_RE = /(全年无休|周一正常开放|每周一开放|不闭馆)/;

function formatYmdLocal(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseYmdLocal(ymd) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(ymd ?? '').trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(year, month - 1, day, 12, 0, 0, 0);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return d;
}

function addDaysLocal(baseDate, offsetDays) {
  const d = new Date(baseDate.getTime());
  d.setDate(d.getDate() + offsetDays);
  return d;
}

/**
 * 生成快捷出行日期胶囊（明天 / 本周六 / 下周六），方便用户一键勾选以触发闭馆与预约核对。
 * @param {Date} [clock]
 */
export function quickTripDatePresets(clock = new Date()) {
  const today = new Date(clock.getFullYear(), clock.getMonth(), clock.getDate(), 12, 0, 0, 0);
  const tomorrow = addDaysLocal(today, 1);
  const dow = today.getDay();
  const daysToSat = dow === 6 ? 0 : (6 - dow + 7) % 7;
  const thisSat = addDaysLocal(today, daysToSat === 0 ? 7 : daysToSat);
  const nextSat = addDaysLocal(thisSat, 7);

  const items = [
    {
      key: 'tomorrow',
      label: `明天（${tomorrow.getMonth() + 1}.${tomorrow.getDate()} ${WEEKDAY_NAMES[tomorrow.getDay()]}）`,
      shortLabel: '明天',
      ymd: formatYmdLocal(tomorrow)
    },
    { key: 'this-sat', label: `周六（${thisSat.getMonth() + 1}.${thisSat.getDate()}）`, shortLabel: '本周六', ymd: formatYmdLocal(thisSat) },
    { key: 'next-sat', label: `下周六（${nextSat.getMonth() + 1}.${nextSat.getDate()}）`, shortLabel: '下周六', ymd: formatYmdLocal(nextSat) }
  ];
  const seen = new Set();
  return items.filter((item) => {
    if (seen.has(item.ymd)) return false;
    seen.add(item.ymd);
    return true;
  });
}

/**
 * 从站点说明或已知场馆类型中提取闭馆星期集合（0=周日 .. 6=周六）。
 * @param {any} stop
 * @param {any[]} [claims]
 */
export function detectClosedWeekdays(stop, claims = []) {
  const claimText = (Array.isArray(claims) ? claims : []).map((c) => `${c?.value ?? ''} ${c?.note ?? ''}`).join('；');
  const combined = `${stop?.verify ?? ''}；${stop?.risk ?? ''}；${stop?.openHours?.note ?? ''}；${claimText}`;
  if (ALWAYS_OPEN_OVERRIDE_RE.test(combined) || stop?.openHours?.alwaysOpen) return { weekdays: [], reason: '' };

  const closed = new Set(Array.isArray(stop?.openHours?.closedWeekdays) ? stop.openHours.closedWeekdays : []);
  let matchedPhrase = '';

  const regex = /(?:每?周|星期)([一二三四五六日天])(?:上午|12点前|半天)?(?:例行)?(?:闭馆|闭园|休息|不开放|公休)/g;
  let match;
  while ((match = regex.exec(combined)) !== null) {
    const idx = CN_WEEKDAY_TO_INDEX[match[1]];
    if (idx !== undefined) {
      closed.add(idx);
      if (!matchedPhrase) matchedPhrase = match[0];
    }
  }

  const name = String(stop?.name ?? '').trim();
  if (!closed.size && (KNOWN_MONDAY_CLOSED_RE.test(name) || KNOWN_MONDAY_CLOSED_NAMES.has(name))) {
    closed.add(1);
    matchedPhrase = '公立场馆通常周一闭馆';
  }

  return {
    weekdays: [...closed],
    reason: matchedPhrase || (closed.size ? `周${['日', '一', '二', '三', '四', '五', '六'][[...closed][0]]}闭馆` : '')
  };
}

/**
 * 提取预约提前天数建议（如「提前 3 天预约」）。
 * @param {any} stop
 * @param {any[]} [claims]
 */
export function extractReservationLeadHint(stop, claims = []) {
  const claimText = (Array.isArray(claims) ? claims : []).map((c) => `${c?.value ?? ''} ${c?.note ?? ''}`).join('；');
  const combined = `${stop?.verify ?? ''}；${stop?.risk ?? ''}；${stop?.costInfo?.note ?? ''}；${claimText}`;
  if (/(不需|无需|不用|免)(?:要)?(?:提前)?(?:实名)?预约/.test(combined)) return '';
  const name = String(stop?.name ?? '').trim();
  const knownLead = KNOWN_RESERVATION_LEAD_DAYS.get(name);
  if (!/预约/.test(combined) && !stop?.costInfo?.reservationRequired && !knownLead) return '';

  const leadMatch = /提前\s*(\d+)\s*(?:[-~至到]\s*(\d+)\s*)?(天|日|小时)/.exec(combined);
  if (leadMatch) {
    const maxLead = Number(leadMatch[2] || leadMatch[1]);
    const unit = leadMatch[3] === '小时' ? '小时' : '天';
    return `建议提前 ${maxLead} ${unit}预约`;
  }
  if (knownLead) return `热门场馆建议提前 ${knownLead} 天关注官方放票`;
  if (/公众号/.test(combined)) return '建议出发前在官方公众号预约';
  return '建议提前查好官方预约放票时间';
}

/**
 * 全行程「替你查好」自动诊断汇总。
 * @param {any} routebook
 * @param {{ claimsForStop?: (stop: any) => any[], verifiedStopCount?: number, clock?: Date }} [opts]
 */
export function analyzePreTripReadiness(routebook, { claimsForStop = () => [], verifiedStopCount = 0, clock = new Date() } = {}) {
  const stops = Array.isArray(routebook?.stops) ? routebook.stops : [];
  const days = Array.isArray(routebook?.days) && routebook.days.length ? routebook.days : [...new Set(stops.map((s) => s.day || 'Day 1'))];
  const rawDate = String(routebook?.constraints?.date || routebook?.travelDate || '').trim();
  const startDate = parseYmdLocal(rawDate);
  const today = new Date(clock.getFullYear(), clock.getMonth(), clock.getDate(), 12, 0, 0, 0);
  const daysUntilDeparture = startDate ? Math.round((startDate.getTime() - today.getTime()) / 86_400_000) : null;

  const daySchedules = days.map((day, index) => {
    if (!startDate) return { day, index, dateYmd: '', dateShort: '', weekdayIndex: null, weekdayLabel: '' };
    const dateObj = addDaysLocal(startDate, index);
    const weekdayIndex = dateObj.getDay();
    return {
      day,
      index,
      dateYmd: formatYmdLocal(dateObj),
      dateShort: `${dateObj.getMonth() + 1}月${dateObj.getDate()}日`,
      weekdayIndex,
      weekdayLabel: WEEKDAY_NAMES[weekdayIndex]
    };
  });
  const scheduleByDay = new Map(daySchedules.map((d) => [d.day, d]));

  const closureConflicts = [];
  const reservationPlans = [];

  for (const stop of stops) {
    const claims = claimsForStop(stop) || [];
    const dayKey = stop.day || days[0] || 'Day 1';
    const sched = scheduleByDay.get(dayKey);
    const closedInfo = detectClosedWeekdays(stop, claims);

    if (sched && sched.weekdayIndex !== null && closedInfo.weekdays.includes(sched.weekdayIndex)) {
      const altDayEntry = daySchedules.find((d) => d.day !== dayKey && d.weekdayIndex !== null && !closedInfo.weekdays.includes(d.weekdayIndex));
      closureConflicts.push({
        stopId: stop.id,
        stopName: stop.name,
        day: dayKey,
        dateShort: sched.dateShort,
        weekdayLabel: sched.weekdayLabel,
        reason: closedInfo.reason,
        suggestedDay: altDayEntry?.day || '',
        suggestedWeekday: altDayEntry?.weekdayLabel || ''
      });
    }

    const resHint = extractReservationLeadHint(stop, claims);
    if (resHint) {
      let timingNote = resHint;
      if (daysUntilDeparture !== null && daysUntilDeparture >= 0 && daysUntilDeparture <= 7) {
        timingNote = daysUntilDeparture === 0 ? `今天出发 · ${resHint}` : `距出发还有 ${daysUntilDeparture} 天 · 现在可去预约`;
      }
      reservationPlans.push({
        stopId: stop.id,
        stopName: stop.name,
        day: dayKey,
        hint: timingNote
      });
    }
  }

  const road = roadSummary(stops, routebook?.routeLegs ?? []);
  const pendingCoords = stops.filter((stop) => stop.navigationDisabled === true || stop.coordinateSource === 'user-edit').length;
  const transitWindow = analyzeTransitWindow(stops, days, routebook?.constraints);
  const costBreakdown = summarizeCostByCategory(stops);

  return {
    travelDate: startDate ? formatYmdLocal(startDate) : '',
    daysUntilDeparture,
    daySchedules,
    closureConflicts,
    reservationPlans,
    transitWindow,
    costBreakdown,
    roadComplete: road.expectedLegs > 0 && road.verifiedLegs >= road.expectedLegs && pendingCoords === 0,
    roadExpectedLegs: road.expectedLegs,
    roadVerifiedLegs: road.verifiedLegs,
    pendingCoords,
    verifiedStopCount,
    totalStops: stops.length
  };
}

function parseClockMinutes(clock) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(clock ?? '').trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  return hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59 ? hh * 60 + mm : null;
}

function formatClockMinutes(totalMinutes) {
  const clamped = Math.max(0, Math.min(23 * 60 + 59, Math.round(totalMinutes)));
  const hh = String(Math.floor(clamped / 60)).padStart(2, '0');
  const mm = String(clamped % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

function parseStayMinutesSimple(stay) {
  const text = String(stay ?? '');
  const hm = /(\d+(?:\.\d+)?)\s*(?:个?小时|h)/i.exec(text);
  if (hm) return Math.round(Number(hm[1]) * 60);
  const mm = /(\d+)\s*分钟/.exec(text);
  if (mm) return Number(mm[1]);
  return 60;
}

export function analyzeTransitWindow(stops = [], days = [], constraints = {}) {
  const arrivalTime = String(constraints?.arrivalTime ?? '').trim();
  const arrivalHub = String(constraints?.arrivalHub ?? '').trim();
  const departureTime = String(constraints?.departureTime ?? '').trim();
  const departureHub = String(constraints?.departureHub ?? '').trim();
  const hasWindow = Boolean(arrivalTime || arrivalHub || departureTime || departureHub);
  if (!hasWindow) {
    return {
      hasWindow: false,
      summaryText: '',
      leaveByClock: '',
      arrivalConflict: '',
      departureConflict: ''
    };
  }

  const firstDay = days[0] || 'Day 1';
  const lastDay = days.at(-1) || firstDay;
  const firstDayStops = stops.filter((s) => (s.day || 'Day 1') === firstDay);
  const lastDayStops = stops.filter((s) => (s.day || 'Day 1') === lastDay);

  const arrMin = parseClockMinutes(arrivalTime);
  const depMin = parseClockMinutes(departureTime);
  const leaveByClock = depMin != null ? formatClockMinutes(depMin - 75) : '';

  let arrivalConflict = '';
  if (arrMin != null && firstDayStops.length) {
    const withStart = firstDayStops
      .map((s) => ({ stop: s, startMin: parseClockMinutes(s?.time) }))
      .filter((x) => x.startMin != null)
      .sort((a, b) => a.startMin - b.startMin);
    if (withStart.length && withStart[0].startMin < arrMin + 25) {
      arrivalConflict = `${firstDay} 首站「${withStart[0].stop.name}」排在 ${withStart[0].stop.time}，紧贴 ${arrivalTime} 到站时间`;
    }
  }

  let departureConflict = '';
  if (depMin != null && lastDayStops.length) {
    const withEnd = lastDayStops
      .map((s) => {
        const sm = parseClockMinutes(s?.time);
        return sm == null ? null : { stop: s, endMin: sm + parseStayMinutesSimple(s?.stay) };
      })
      .filter(Boolean)
      .sort((a, b) => b.endMin - a.endMin);
    if (withEnd.length && withEnd[0].endMin > depMin - 50) {
      departureConflict = `${lastDay} 末站「${withEnd[0].stop.name}」预计逛到 ${formatClockMinutes(withEnd[0].endMin)}，距 ${departureTime} 返程较紧`;
    }
  }

  const parts = [];
  if (arrivalTime || arrivalHub) parts.push(`首日${arrivalTime ? ` ${arrivalTime}` : ''}到${arrivalHub || '目的地'}`);
  if (departureTime || departureHub) {
    parts.push(`末日${departureTime ? ` ${departureTime}` : ''}从${departureHub || '车站'}返程${leaveByClock ? `（建议 ${leaveByClock} 动身去车站）` : ''}`);
  }

  return {
    hasWindow: true,
    arrivalTime,
    arrivalHub,
    departureTime,
    departureHub,
    leaveByClock,
    summaryText: parts.join(' · '),
    arrivalConflict,
    departureConflict
  };
}

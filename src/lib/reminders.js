import { readTripSession } from './tripSession.js';
import { trackEvent } from './betaTelemetry.js';

const REMINDER_KEY = 'trusted-routebook:trip-reminders:v1';
// 出行日之后仍保留 3 天窗口提示补打开行中模式，再往后自动清理。
const REMINDER_GRACE_DAYS = 3;

export function readTripReminders() {
  try {
    const rows = JSON.parse(localStorage.getItem(REMINDER_KEY) ?? '[]');
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

export function saveTripReminder(routebook) {
  const date = routebook?.constraints?.date || routebook?.travelDate || routebook?.provider?.travelDate;
  if (!isDateString(date)) return { ok: false, reason: '这份路书没有出行日期' };
  const reminder = {
    routeId: routebook.publicId || routebook.id || routebook.title,
    title: routebook.title,
    city: routebook.city,
    date,
    createdAt: new Date().toISOString()
  };
  const existing = readTripReminders().filter((item) => item.routeId !== reminder.routeId);
  writeTripReminders([reminder, ...existing].slice(0, 80));
  return { ok: true, reminder };
}

export function dueTripReminders(routebooks = []) {
  const today = todayDateString();
  const booksById = new Map(routebooks.map((book) => [book.publicId || book.id || book.title, book]));
  const all = readTripReminders();
  const kept = [];
  const due = [];
  for (const item of all) {
    if (!isDateString(item?.date)) continue;
    // 出行日已过 3 天以上：自动清理，不再提示。
    if (daysSince(item.date, today) > REMINDER_GRACE_DAYS) continue;
    kept.push(item);
    if (item.dismissedAt) continue;
    if (item.date > today) continue;
    const routebook = booksById.get(item.routeId) || null;
    if (isTripCompleted(routebook)) continue;
    due.push({ ...item, routebook });
  }
  if (kept.length !== all.length) writeTripReminders(kept);
  return due;
}

export function dismissTripReminder(routeId) {
  writeTripReminders(readTripReminders().map((item) => (item.routeId === routeId ? { ...item, dismissedAt: new Date().toISOString() } : item)));
}

export function mergeTripRemindersFromCloud(cloudRows = []) {
  const local = readTripReminders();
  const merged = [];
  const seen = new Set();
  for (const item of [...local, ...(Array.isArray(cloudRows) ? cloudRows : [])]) {
    const routeId = String(item?.routeId ?? '').trim();
    const date = String(item?.date ?? '').trim();
    if (!routeId || !isDateString(date) || seen.has(routeId)) continue;
    seen.add(routeId);
    merged.push({
      routeId,
      title: String(item.title ?? ''),
      city: String(item.city ?? ''),
      date,
      ...(item.dismissedAt ? { dismissedAt: item.dismissedAt } : {}),
      createdAt: String(item.createdAt || new Date().toISOString())
    });
    if (merged.length >= 80) break;
  }
  writeTripReminders(merged);
  return merged;
}

// 与实际能力一致的文案：提醒只在「出行当天打开本站」时以站内横幅提示，
// 不做系统级定时推送（浏览器网页无法在未打开时主动推送）。
export async function requestTripNotification(routebook) {
  const saved = saveTripReminder(routebook);
  if (!saved.ok) return saved;
  const savedReason = '已保存站内提醒：出行当天打开本站会提示进入行中模式';
  if (!('Notification' in window)) return { ok: true, reason: savedReason };
  const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
  if (permission !== 'granted') {
    return { ok: true, reason: `${savedReason}（浏览器通知未授权，不影响站内提示）` };
  }
  new Notification('可信路书提醒已保存', {
    body: `${routebook.city || ''}${routebook.title || '路书'}：出行当天打开本站会提示进入行中模式，不会主动推送。`
  });
  return { ok: true, reason: savedReason };
}

export function buildTripIcsContent(routebook) {
  const date = routebook?.constraints?.date || routebook?.travelDate || routebook?.provider?.travelDate;
  if (!isDateString(date)) return '';
  const baseUid = `${routebook.publicId || routebook.id || routebook.title}@trusted-routebook`;
  const stamp = formatUtcDate(new Date());
  const title = escapeIcsText(`打开行中模式：${routebook.title || '可信路书'}`);
  const description = escapeIcsText(`目的地：${routebook.city || ''}。出发当天打开可信路书，按站点导航和打卡。`);
  const dayCompact = date.replaceAll('-', '');

  const events = [
    [
      'BEGIN:VEVENT',
      `UID:${baseUid}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${dayCompact}`,
      `SUMMARY:${title}`,
      `DESCRIPTION:${description}`,
      'END:VEVENT'
    ].join('\r\n')
  ];

  const stops = Array.isArray(routebook?.stops) ? routebook.stops : [];
  const days = Array.isArray(routebook?.days) && routebook.days.length ? routebook.days : [...new Set(stops.map((s) => s.day || 'Day 1'))];

  // 1) 提前预约抢票闹钟（出发前 7 天 09:00）
  const reservationStops = stops.filter((s) => /预约|博物院|博物馆|拙政园|中山陵|总统府/.test(`${s?.name ?? ''}${s?.verify ?? ''}${s?.risk ?? ''}`));
  if (reservationStops.length) {
    const bookDate = shiftYmd(date, -7);
    if (bookDate) {
      const bookCompact = bookDate.replaceAll('-', '');
      const names = reservationStops
        .slice(0, 4)
        .map((s) => s.name)
        .join('、');
      events.push(
        [
          'BEGIN:VEVENT',
          `UID:booking-${baseUid}`,
          `DTSTAMP:${stamp}`,
          `DTSTART:${bookCompact}T090000`,
          `DTEND:${bookCompact}T093000`,
          `SUMMARY:${escapeIcsText(`行前预约提醒：${names}`)}`,
          `DESCRIPTION:${escapeIcsText(`距离${routebook.city || ''}出行还有7天，请查验公众号或官方渠道预约放票：${names}`)}`,
          'BEGIN:VALARM',
          'TRIGGER:-PT15M',
          'ACTION:DISPLAY',
          `DESCRIPTION:${escapeIcsText(`记得预约门票：${names}`)}`,
          'END:VALARM',
          'END:VEVENT'
        ].join('\r\n')
      );
    }
  }

  // 2) 各站点日程事件
  stops.slice(0, 24).forEach((stop, idx) => {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(stop?.time ?? '').trim());
    if (!m) return;
    const dayIdx = Math.max(0, days.indexOf(stop.day || 'Day 1'));
    const stopYmd = shiftYmd(date, dayIdx);
    if (!stopYmd) return;
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (hh > 23 || mm > 59) return;
    const startMin = hh * 60 + mm;
    const endMin = Math.min(23 * 60 + 55, startMin + 60);
    const dCompact = stopYmd.replaceAll('-', '');
    const fmtClock = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}${String(mins % 60).padStart(2, '0')}00`;
    events.push(
      [
        'BEGIN:VEVENT',
        `UID:stop-${idx + 1}-${baseUid}`,
        `DTSTAMP:${stamp}`,
        `DTSTART:${dCompact}T${fmtClock(startMin)}`,
        `DTEND:${dCompact}T${fmtClock(endMin)}`,
        `SUMMARY:${escapeIcsText(`${stop.name || '站点'}（${routebook.city || ''}）`)}`,
        `DESCRIPTION:${escapeIcsText([stop.stay ? `建议停留：${stop.stay}` : '', stop.verify || ''].filter(Boolean).join('；'))}`,
        'END:VEVENT'
      ].join('\r\n')
    );
  });

  // 3) 末日返程去车站闹钟
  const depMatch = /^(\d{1,2}):(\d{2})$/.exec(String(routebook?.constraints?.departureTime ?? '').trim());
  if (depMatch) {
    const lastDayYmd = shiftYmd(date, Math.max(0, days.length - 1));
    if (lastDayYmd) {
      const depMin = Number(depMatch[1]) * 60 + Number(depMatch[2]);
      const leaveMin = Math.max(0, depMin - 75);
      const dCompact = lastDayYmd.replaceAll('-', '');
      const fmtClock = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}${String(mins % 60).padStart(2, '0')}00`;
      const hub = routebook?.constraints?.departureHub || '车站/机场';
      events.push(
        [
          'BEGIN:VEVENT',
          `UID:departure-${baseUid}`,
          `DTSTAMP:${stamp}`,
          `DTSTART:${dCompact}T${fmtClock(leaveMin)}`,
          `DTEND:${dCompact}T${fmtClock(depMin)}`,
          `SUMMARY:${escapeIcsText(`动身去${hub}赶返程（${routebook.constraints.departureTime}）`)}`,
          'BEGIN:VALARM',
          'TRIGGER:-PT15M',
          'ACTION:DISPLAY',
          `DESCRIPTION:${escapeIcsText(`准备出发前往${hub}`)}`,
          'END:VALARM',
          'END:VEVENT'
        ].join('\r\n')
      );
    }
  }

  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Trusted Routebook//Trip Reminder//CN', ...events, 'END:VCALENDAR'].join('\r\n');
}

export function downloadTripIcs(routebook) {
  const ics = buildTripIcsContent(routebook);
  if (!ics) return { ok: false, reason: '这份路书没有出行日期' };
  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${routebook.city || 'trip'}-${routebook.title || 'routebook'}.ics`.replace(/[\\/:*?"<>|]+/g, '-');
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  trackEvent('itinerary_print', 'ics');
  return { ok: true, reason: '已下载日历提醒（含预约与返程闹钟）' };
}

function shiftYmd(ymd, deltaDays) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd ?? ''));
  if (!m) return '';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0, 0);
  d.setDate(d.getDate() + deltaDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function writeTripReminders(rows) {
  try {
    localStorage.setItem(REMINDER_KEY, JSON.stringify(rows));
  } catch {
    // Ignore storage failures; caller still has ICS fallback.
  }
}

function isDateString(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ''));
}

function daysSince(dateString, todayString) {
  const from = Date.parse(dateString);
  const to = Date.parse(todayString);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.floor((to - from) / (24 * 60 * 60 * 1000));
}

// 行程已全部处理（到达/跳过）时不再提示进入行中模式。
function isTripCompleted(routebook) {
  if (!routebook) return false;
  try {
    const session = readTripSession(routebook, currentProfileId());
    const stops = session?.stops ?? [];
    if (!stops.length) return false;
    return stops.every((stop) => ['visited', 'skipped'].includes(stop?.tripStatus));
  } catch {
    return false;
  }
}

function currentProfileId() {
  try {
    const profile = JSON.parse(localStorage.getItem('trusted-routebook:profile:v1') ?? '{}');
    return profile?.id || 'anonymous';
  } catch {
    return 'anonymous';
  }
}

function todayDateString() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatUtcDate(date) {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

function escapeIcsText(value) {
  return String(value ?? '')
    .replaceAll('\\', '\\\\')
    .replaceAll('\n', '\\n')
    .replaceAll(',', '\\,')
    .replaceAll(';', '\\;');
}

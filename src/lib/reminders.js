import { readTripSession } from './tripSession.js';

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

export function downloadTripIcs(routebook) {
  const date = routebook?.constraints?.date || routebook?.travelDate || routebook?.provider?.travelDate;
  if (!isDateString(date)) return { ok: false, reason: '这份路书没有出行日期' };
  const uid = `${routebook.publicId || routebook.id || routebook.title}@trusted-routebook`;
  const title = escapeIcsText(`打开行中模式：${routebook.title || '可信路书'}`);
  const description = escapeIcsText(`目的地：${routebook.city || ''}。出发当天打开可信路书，按站点导航和打卡。`);
  const day = date.replaceAll('-', '');
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Trusted Routebook//Trip Reminder//CN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${formatUtcDate(new Date())}`,
    `DTSTART;VALUE=DATE:${day}`,
    `SUMMARY:${title}`,
    `DESCRIPTION:${description}`,
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');
  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${routebook.city || 'trip'}-${routebook.title || 'routebook'}.ics`.replace(/[\\/:*?"<>|]+/g, '-');
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  return { ok: true, reason: '已下载日历提醒' };
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

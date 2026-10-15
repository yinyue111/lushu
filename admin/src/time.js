// Admin console times: always Asia/Shanghai, labelled 「北京时间」 (the team's day, UTC+8).
const TZ = 'Asia/Shanghai';

/**
 * @param {string | number | Date | null | undefined} value
 * @param {{ hhmm?: boolean, zoneLabel?: boolean }} [options]
 *   hhmm: only HH:mm
 *   zoneLabel: append 「（北京时间）」 (default true for standalone; tables put it in the header)
 */
export function formatTime(value, { hhmm = false, zoneLabel = true } = {}) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const text = hhmm
    ? new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date)
    : date.toLocaleString('zh-CN', { timeZone: TZ, hour12: false });
  return zoneLabel ? `${text}（北京时间）` : text;
}

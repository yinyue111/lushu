import { generationModeLabel } from './generationModes.js';

/**
 * Relative date for card lists, by the calendar day of the viewer's device time zone (Date local getters;
 * no fixed zone). For users in mainland China that is Asia/Shanghai (UTC+8).
 */
export function formatRoutebookWhen(iso) {
  const ms = Date.parse(iso ?? '') || 0;
  if (!ms) return '';
  const date = new Date(ms);
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startThat = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDiff = Math.round((startToday - startThat) / 86400000);
  if (dayDiff === 0) return '今天';
  if (dayDiff === 1) return '昨天';
  if (dayDiff > 1 && dayDiff < 7) return `${dayDiff} 天前`;
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

/** Card meta line: time · 轻快/细品 · first stop · stop count … */
export function routebookCardMeta(book, { extra = '' } = {}) {
  const when = formatRoutebookWhen(book?.provider?.editedAt || book?.updatedAt || book?.provider?.generatedAt || book?.createdAt);
  const mode = generationModeLabel(book?.provider?.mode || book?.generationMode || '');
  const first = String(book?.stops?.[0]?.name ?? '').trim();
  const stops = book?.stops?.length ?? 0;
  const parts = [when, mode, first ? `首站 ${first}` : '', stops ? `${stops} 站` : '', extra].filter(Boolean);
  return parts.join(' · ');
}

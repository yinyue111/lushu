// 内测激活漏斗：首页 → 进入创建 → 注册 → 首份生成成功 → 分享被打开。
// 只记事件名、匿名键（profileId 的 HMAC 截断）和时间，不记攻略内容、邮箱或 IP。
import { createHmac } from 'node:crypto';
import { CLIENT_ERROR_LOG_PATH, FUNNEL_LOG_PATH, PROFILE_ID_SECRET } from '../config/index.mjs';
import { appendJsonLine } from '../storage/jsonl.mjs';
import { truncateString } from '../lib/util.mjs';

export const CLIENT_FUNNEL_EVENTS = new Set(['home_view', 'create_start']);
export const SERVER_FUNNEL_EVENTS = new Set(['register_complete', 'share_open']);
export const ACTIVATION_STEPS = [
  { key: 'home_view', label: '到达首页' },
  { key: 'create_start', label: '进入创建' },
  { key: 'register_complete', label: '完成注册' },
  { key: 'first_generation_success', label: '首份生成成功' },
  { key: 'share_open', label: '分享被打开' }
];

export function funnelKey(profileId) {
  const id = String(profileId ?? '').trim();
  if (!id || id === 'anonymous') return '';
  return createHmac('sha256', `funnel:${PROFILE_ID_SECRET}`).update(id).digest('hex').slice(0, 16);
}

export async function recordFunnelEvent(event, { profileId = '', ref = '' } = {}) {
  if (!CLIENT_FUNNEL_EVENTS.has(event) && !SERVER_FUNNEL_EVENTS.has(event)) return null;
  const row = { event, key: funnelKey(profileId), ref: truncateString(ref, 40), createdAt: new Date().toISOString() };
  try {
    await appendJsonLine(FUNNEL_LOG_PATH, row);
  } catch (error) {
    // 埋点失败不影响主流程，但要留痕，避免像缺迁移这样的问题被静默吞掉。
    console.warn("[funnel] record failed", event, String(error?.message ?? error));
  }
  return row;
}

/**
 * 漏斗每一步按「去重人数」计（没有匿名键的按次数计）；首份生成成功来自 AI 日志里成功的生成。
 * 注意：各步按人独立去重，不是严格的同一批人（注册前后的匿名 profile 可能不同）。
 */
export function buildActivationFunnel(rows = [], aiLogs = [], { sinceMs = 0 } = {}) {
  const inWindow = (at) => !sinceMs || Date.parse(at) >= sinceMs;
  const counts = new Map(ACTIVATION_STEPS.map((step) => [step.key, { keys: new Set(), anonymous: 0 }]));
  for (const row of rows) {
    if (!counts.has(row?.event) || !inWindow(row.createdAt)) continue;
    const bucket = counts.get(row.event);
    if (row.key) bucket.keys.add(row.key);
    else bucket.anonymous += 1;
  }
  const success = counts.get('first_generation_success');
  for (const log of aiLogs) {
    if (log?.kind !== 'generate-routebook' || log?.status !== 'ok' || !inWindow(log.createdAt)) continue;
    const key = funnelKey(log.profileId);
    if (key) success.keys.add(key);
    else success.anonymous += 1;
  }
  let previous = null;
  return ACTIVATION_STEPS.map((step) => {
    const bucket = counts.get(step.key);
    const value = bucket.keys.size + bucket.anonymous;
    const item = { ...step, count: value, rateFromPrevious: previous ? (previous > 0 ? Math.round((value / previous) * 100) : null) : null };
    previous = value;
    return item;
  });
}

const MAX_CLIENT_ERROR_TEXT = 500;
/** 前端错误：只留消息、栈的前几行、页面路径（不含查询串）和版本。 */
export function normalizeClientError(input = {}) {
  let path = '';
  try {
    path = new URL(String(input.url ?? ''), 'http://x').pathname.slice(0, 120);
  } catch {
    path = '';
  }
  return {
    kind: ['render', 'error', 'unhandledrejection'].includes(input.kind) ? input.kind : 'error',
    message: truncateString(String(input.message ?? ''), MAX_CLIENT_ERROR_TEXT) || '(no message)',
    stack: truncateString(String(input.stack ?? '').split('\n').slice(0, 6).join('\n'), 1200),
    path,
    release: truncateString(input.release, 40),
    userAgent: truncateString(input.userAgent, 160),
    createdAt: new Date().toISOString()
  };
}

export async function recordClientError(input) {
  const row = normalizeClientError(input);
  await appendJsonLine(CLIENT_ERROR_LOG_PATH, row);
  console.warn('[client-error]', row.kind, row.path, row.message);
  return row;
}

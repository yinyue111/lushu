// 内测激活漏斗：首页 → 进入创建 → 注册 → 首份生成成功 → 分享被打开。
// 只记事件名、匿名键（profileId 的 HMAC 截断）和时间，不记攻略内容、邮箱或 IP。
import { createHmac } from 'node:crypto';
import { CLIENT_ERROR_LOG_PATH, FUNNEL_LOG_PATH, PROFILE_ID_SECRET } from '../config/index.mjs';
import { appendJsonLine } from '../storage/jsonl.mjs';
import { truncateString } from '../lib/util.mjs';
import { raiseAlert } from '../ops/alerts.mjs';

export const CLIENT_FUNNEL_EVENTS = new Set(['home_view', 'create_start', 'share_copy']);
// 信任行为：点开「待确认」、点开来源、报错、隔天再打开同一份路书。只记次数和人，不记内容。
export const CLIENT_TRUST_EVENTS = new Set(['route_view', 'confirm_open', 'source_open', 'fact_report', 'revisit']);
export const SERVER_FUNNEL_EVENTS = new Set(['register_complete', 'share_open']);
export const ACTIVATION_STEPS = [
  { key: 'home_view', label: '到达首页/创建页' },
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

export async function recordFunnelEvent(event, { profileId = '', ref = '', aliasOf = '' } = {}) {
  if (!CLIENT_FUNNEL_EVENTS.has(event) && !SERVER_FUNNEL_EVENTS.has(event) && !CLIENT_TRUST_EVENTS.has(event)) return null;
  const row = { event, key: funnelKey(profileId), ref: truncateString(ref, 40), createdAt: new Date().toISOString() };
  // 注册时账号 profile 和注册前的设备 profile 不同：记下别名，漏斗才能按同一个人串起来。
  const alias = funnelKey(aliasOf);
  if (alias && alias !== row.key) row.aliasOf = alias;
  try {
    await appendJsonLine(FUNNEL_LOG_PATH, row);
  } catch (error) {
    // 埋点失败不影响主流程，但要留痕，避免像缺迁移这样的问题被静默吞掉。
    console.warn('[funnel] record failed', event, String(error?.message ?? error));
  }
  return row;
}

/**
 * 同一批人的激活漏斗（cohort）：窗口内到过首页或进入创建的匿名键算一批，
 * 每一步只数「这批人里前面每一步都做过」的人。注册时的别名把设备键并到账号键上。
 * 分享被打开记在分享者名下。没有匿名键的事件进不了 cohort，单独计数供参考。
 */
export function buildActivationFunnel(rows = [], aiLogs = [], { sinceMs = 0 } = {}) {
  const inWindow = (at) => !sinceMs || Date.parse(at) >= sinceMs;
  const alias = new Map();
  for (const row of rows) if (row?.aliasOf && row.key) alias.set(row.aliasOf, row.key);
  const person = (key) => alias.get(key) || key;
  const firstAt = new Map(ACTIVATION_STEPS.map((step) => [step.key, new Map()]));
  const mark = (step, key, at) => {
    if (!key) return;
    const map = firstAt.get(step);
    const id = person(key);
    const t = Date.parse(at) || 0;
    if (!map.has(id) || t < map.get(id)) map.set(id, t);
  };
  let anonymous = 0;
  for (const row of rows) {
    if (!firstAt.has(row?.event) || !inWindow(row.createdAt)) continue;
    if (!row.key) anonymous += 1;
    mark(row.event, row.key, row.createdAt);
  }
  for (const log of aiLogs) {
    if (log?.kind !== 'generate-routebook' || log?.status !== 'ok' || !inWindow(log.createdAt)) continue;
    mark('first_generation_success', funnelKey(log.profileId), log.createdAt);
  }
  const cohort = new Set([...firstAt.get('home_view').keys(), ...firstAt.get('create_start').keys()]);
  let survivors = cohort;
  let previous = null;
  const steps = ACTIVATION_STEPS.map((step, index) => {
    if (index > 0 && step.key !== 'create_start') survivors = new Set([...survivors].filter((id) => firstAt.get(step.key).has(id)));
    if (step.key === 'create_start') survivors = new Set([...cohort].filter((id) => firstAt.get('create_start').has(id)));
    const value = index === 0 ? cohort.size : survivors.size;
    const item = { ...step, count: value, rateFromPrevious: previous === null ? null : previous > 0 ? Math.round((value / previous) * 100) : null };
    previous = value;
    return item;
  });
  /** @type {any} */ (steps).cohortSize = cohort.size;
  /** @type {any} */ (steps).anonymousEvents = anonymous;
  return steps;
}

/** 进入创建 → 首份生成成功的中位耗时（分钟），同一人。 */
export function medianMinutesToFirstSuccess(rows = [], aiLogs = [], { sinceMs = 0 } = {}) {
  const alias = new Map();
  for (const row of rows) if (row?.aliasOf && row.key) alias.set(row.aliasOf, row.key);
  const person = (key) => alias.get(key) || key;
  const start = new Map();
  for (const row of rows) {
    if (row?.event !== 'create_start' || !row.key || (sinceMs && Date.parse(row.createdAt) < sinceMs)) continue;
    const id = person(row.key);
    const t = Date.parse(row.createdAt);
    if (!start.has(id) || t < start.get(id)) start.set(id, t);
  }
  const done = new Map();
  for (const log of aiLogs) {
    if (log?.kind !== 'generate-routebook' || log?.status !== 'ok') continue;
    const id = person(funnelKey(log.profileId));
    const t = Date.parse(log.createdAt);
    if (!start.has(id) || t < start.get(id)) continue;
    if (!done.has(id) || t < done.get(id)) done.set(id, t);
  }
  const minutes = [...done].map(([id, t]) => (t - start.get(id)) / 60000).sort((a, b) => a - b);
  if (!minutes.length) return { median: null, samples: 0 };
  const mid = Math.floor(minutes.length / 2);
  const median = minutes.length % 2 ? minutes[mid] : (minutes[mid - 1] + minutes[mid]) / 2;
  return { median: Math.round(median * 10) / 10, samples: minutes.length };
}

/** 信任行为统计：每类事件的人数和次数；「待确认」打开率 = 点开过的人 / 打开过路书的人（route_view；无分母时为 null）。 */
export function buildTrustBehavior(rows = [], { sinceMs = 0 } = {}) {
  const stats = {};
  for (const event of CLIENT_TRUST_EVENTS) stats[event] = { people: new Set(), count: 0 };
  for (const row of rows) {
    if (!CLIENT_TRUST_EVENTS.has(row?.event) || (sinceMs && Date.parse(row.createdAt) < sinceMs)) continue;
    stats[row.event].count += 1;
    if (row.key) stats[row.event].people.add(row.key);
  }
  const out = /** @type {any} */ (Object.fromEntries(Object.entries(stats).map(([event, { people, count }]) => [event, { people: people.size, count }])));
  const viewers = out.route_view.people;
  out.confirmOpenRate = viewers > 0 ? Math.round((out.confirm_open.people / viewers) * 100) : null;
  out.revisitRate = viewers > 0 ? Math.round((out.revisit.people / viewers) * 100) : null;
  return out;
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
    stack: truncateString(
      String(input.stack ?? '')
        .split('\n')
        .slice(0, 6)
        .join('\n'),
      1200
    ),
    path,
    release: truncateString(input.release, 40),
    userAgent: truncateString(input.userAgent, 160),
    createdAt: new Date().toISOString()
  };
}

const recentClientErrors = [];
const CLIENT_ERROR_SURGE = Number(process.env.ALERT_CLIENT_ERRORS_PER_HOUR) || 30;
export async function recordClientError(input) {
  const row = normalizeClientError(input);
  const now = Date.now();
  recentClientErrors.push(now);
  while (recentClientErrors.length && now - recentClientErrors[0] > 3_600_000) recentClientErrors.shift();
  if (recentClientErrors.length >= CLIENT_ERROR_SURGE) void raiseAlert('client-error-surge', `近 1 小时前端错误 ${recentClientErrors.length} 条`);
  await appendJsonLine(CLIENT_ERROR_LOG_PATH, row);
  console.warn('[client-error]', row.kind, row.path, row.message);
  return row;
}

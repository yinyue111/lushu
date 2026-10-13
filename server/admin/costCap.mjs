// Daily cost cap (product v4 review): the dashboard number is a LOWER BOUND when some calls have no unit
// price ("至少 $X，另有 N 次没有单价"), so enforcing a cap on it would silently under-count. Mode:
//   auto (default) — enforce only while every generation model has a price and today has no unpriced calls
//   on             — enforce on the known lower bound anyway
//   off            — never block, dashboard only
// No prices are invented anywhere; unpriced calls are counted, not valued at 0.
import { AI_LOG_PATH } from '../config/index.mjs';
import { getConfig } from '../config/runtime.mjs';
import { generationModeConfig } from '../config/runtimeViews.mjs';
import { readMatchingJsonLines } from '../storage/jsonl.mjs';
import { enrichStore } from '../enrich/store.mjs';
import { createHttpError } from '../lib/util.mjs';
import { modelHasPrice } from './cost.mjs';
import { generationCostToday, startOfTodayMs } from './dashboard.mjs';

/** Models whose price is missing among the ones generation would call right now. */
export function unpricedModels() {
  const models = [...new Set(['fast', 'deep'].map((mode) => generationModeConfig(mode).model).filter(Boolean))];
  return models.filter((model) => !modelHasPrice(model));
}

/**
 * @param {{ knownUsd: number, unknownCostCount: number }} spend
 * @returns {{ mode: string, limitUsd: number|null, enforcing: boolean, reason: string, unpricedModels: string[] }}
 */
export function costCapState(spend, { mode = getConfig('cost.capMode'), limitUsd = getConfig('cost.dailyLimitUsd'), missing = unpricedModels() } = {}) {
  const base = { mode, limitUsd: limitUsd || null, unpricedModels: missing };
  if (!limitUsd) return { ...base, enforcing: false, reason: '未设日上限' };
  if (mode === 'off') return { ...base, enforcing: false, reason: '已关闭：只在看板显示，不拦截生成' };
  if (mode === 'on') return { ...base, enforcing: true, reason: spend.unknownCostCount > 0 || missing.length ? '已开启：按已知金额（下限）拦截，没有单价的调用不计' : '已开启' };
  if (missing.length) return { ...base, enforcing: false, reason: `未生效：${missing.join('、')} 没有单价` };
  if (spend.unknownCostCount > 0) return { ...base, enforcing: false, reason: `未生效：今天有 ${spend.unknownCostCount} 次调用没有单价` };
  return { ...base, enforcing: true, reason: '已生效：单价齐全' };
}

let cache = { at: 0, value: /** @type {any} */ (null) };
const CACHE_MS = 15000;

export async function todaySpend(now = Date.now()) {
  if (cache.value && now - cache.at < CACHE_MS) return cache.value;
  const today = startOfTodayMs(now);
  const rows = await readMatchingJsonLines(AI_LOG_PATH, (row) => Date.parse(row?.createdAt ?? '') >= today, 200000, 200000);
  const gen = generationCostToday(rows, now);
  const enrich = await enrichStore()
    .getSpend(now)
    .catch(() => ({ usd: 0 }));
  const value = { knownUsd: gen.generationUsd + gen.testRunUsd + Number(enrich.usd || 0), unknownCostCount: gen.unknownCostCount };
  cache = { at: now, value };
  return value;
}
export const resetCostCapCache = () => (cache = { at: 0, value: null });

/** Throws 429 COST_CAP_REACHED when the cap is enforcing and today's known spend reached it. */
export async function enforceCostCap(now = Date.now()) {
  if (!getConfig('cost.dailyLimitUsd') || getConfig('cost.capMode') === 'off') return;
  const spend = await todaySpend(now);
  const state = costCapState(spend);
  if (!state.enforcing || spend.knownUsd < Number(state.limitUsd)) return;
  const error = createHttpError('今天的 AI 生成名额用完了，明天再来试试。已经生成的路书不受影响。', 429, 'COST_CAP_REACHED');
  /** @type {any} */ (error).retryAfterSeconds = 3600;
  throw error;
}

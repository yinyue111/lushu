import { parseFallbackOrder } from './fallbackOrder.mjs';
import { DEFAULT_MODEL_PRICING } from './modelPricingDefaults.mjs';
// Whitelist of runtime-configurable settings (docs/admin.md, build design §1.2).
// Effective value = parse(DB override) ?? parse(env) ?? safe default. Env values come from
// server/config/index.mjs, which already parsed/clamped them at startup, so env stays the fallback.
// No new dependency: a tiny hand-written validator in the style of envNumber().
import {
  AI_TIMEOUT_MS,
  ENRICH_BASE_URL,
  ENRICH_BUDGET_ALERT_RATIO,
  ENRICH_CONCURRENCY,
  ENRICH_DAILY_BUDGET_USD,
  ENRICH_ENABLED,
  ENRICH_MAX_SEARCHES_PER_ROUTEBOOK,
  ENRICH_MODEL,
  GENERATION_DAILY_LIMIT,
  GENERATION_MODES,
  GENERATION_QUOTA_DEEP_PER_PROFILE,
  GENERATION_QUOTA_PATCH_PER_PROFILE,
  GENERATION_QUOTA_PER_PROFILE,
  GENERATION_REGION,
  REGISTRATION_MODE
} from './index.mjs';
import { envNumber } from './env.mjs';
import { cities as ALL_CITIES, JZH_CITIES } from '../../src/lib/chinaCities.js';

const REASONING = ['', 'low', 'medium', 'high', 'xhigh'];
const PROVIDERS = ['openai-compatible'];
const URL_RE = /^https?:\/\/[^\s]+$/i;

class ConfigValueError extends Error {
  constructor(key, message) {
    super(`${key}: ${message}`);
    this.key = key;
    this.code = 'ADMIN_CONFIG_INVALID';
    this.statusCode = 400;
  }
}

const regionToCities = (region) => (region === 'all' ? [...ALL_CITIES] : [...JZH_CITIES]);
const envTier = (key) => ({
  provider: 'openai-compatible',
  baseUrl: String(process.env.OPENAI_BASE_URL ?? '').trim(),
  model: GENERATION_MODES[key].model || String(process.env.OPENAI_MODEL ?? '').trim(),
  reasoningEffort: GENERATION_MODES[key].reasoningEffort,
  timeoutMs: GENERATION_MODES[key].timeoutMs,
  idleTimeoutMs: GENERATION_MODES[key].idleTimeoutMs
});
/** @returns {any} */
const int = (label, group, min, max, env, def, extra = {}) => ({ type: 'int', label, group, role: 'admin', min, max, env, default: def, ...extra });

/**
 * @typedef {{ type: string, label: string, group: string, role: 'admin'|'operator', env: () => any, default: any,
 *   values?: string[], min?: number, max?: number, items?: () => string[], secret?: boolean, locked?: boolean,
 *   model?: boolean, help?: string, confirmOff?: boolean }} SettingSpec
 * @type {Record<string, SettingSpec>}
 */
export const RUNTIME_SCHEMA = {
  'model.fast': { type: 'modelTier', label: '「轻快」模式的模型', group: 'model', role: 'admin', model: true, env: () => envTier('fast'), default: null },
  'model.deep': { type: 'modelTier', label: '「细品」模式的模型', group: 'model', role: 'admin', model: true, env: () => envTier('deep'), default: null },
  'model.fallbackOrder': {
    type: 'string[]',
    label: '备用模型顺序（所选模式没配好，或上游报错 / 超时时改用）',
    group: 'model',
    role: 'admin',
    items: () => ['fast', 'deep'],
    // Default: 细品 fails → 轻快 (轻快 has nothing to fall back to). AI_MODEL_FALLBACK_ORDER=none turns it off.
    // Invalid values are refused at startup (startup-checks); here only the valid part is used.
    env: () => parseFallbackOrder(process.env.AI_MODEL_FALLBACK_ORDER).order,
    default: ['fast']
  },
  'model.fallbackOnUpstreamError': {
    type: 'bool',
    label: '上游报错时改用备用模型',
    group: 'model',
    role: 'admin',
    env: () => true,
    default: true
  },
  'model.pricing': {
    type: 'pricing',
    // Shipped defaults = official API list prices (server/config/modelPricingDefaults.mjs). Admin may
    // override from the relay bill; clearing a model leaves it unpriced (never stored as 0).
    label: '模型单价（USD / 百万 token；默认官方标价，可按中继账单改；不填则成本记为「未知」）',
    group: 'model',
    role: 'admin',
    env: () => ({ ...DEFAULT_MODEL_PRICING }),
    default: { ...DEFAULT_MODEL_PRICING }
  },
  'registration.mode': {
    type: 'enum',
    label: '注册方式',
    group: 'registration',
    role: 'admin',
    values: ['open', 'invite', 'closed'],
    env: () => REGISTRATION_MODE,
    default: 'invite'
  },
  'generation.openCities': {
    type: 'string[]',
    label: '开放生成的城市',
    group: 'cities',
    role: 'admin',
    items: () => ALL_CITIES,
    env: () => regionToCities(GENERATION_REGION),
    default: [...JZH_CITIES]
  },
  'generation.homeCities': {
    type: 'string[]',
    label: '首页推荐城市（只能从开放城市里选；不在开放范围内的会自动隐藏）',
    group: 'cities',
    role: 'admin',
    items: () => ALL_CITIES,
    env: () => ['杭州', '上海', '苏州'],
    default: ['杭州', '上海', '苏州']
  },
  'generation.dailyLimit': {
    type: 'int',
    label: '全站每日生成上限（0 = 不限）',
    group: 'quota',
    role: 'admin',
    min: 0,
    max: 100000,
    env: () => GENERATION_DAILY_LIMIT,
    default: 300
  },
  'generation.perUserQuota': {
    type: 'int',
    label: '每人窗口内生成次数（0 = 不限）',
    group: 'quota',
    role: 'admin',
    min: 0,
    max: 1000,
    env: () => GENERATION_QUOTA_PER_PROFILE,
    default: 30
  },
  'generation.deepPerUserQuota': int('细品单独上限（每人窗口内，0 = 只用共享额度）', 'quota', 0, 1000, () => GENERATION_QUOTA_DEEP_PER_PROFILE, 0),
  'generation.patchQuotaEnabled': { type: 'bool', label: '局部调整单独计次', group: 'quota', role: 'admin', env: () => true, default: true },
  'generation.patchQuota': int('局部调整每人窗口内次数（0 = 生成额度的 2 倍）', 'quota', 0, 1000, () => GENERATION_QUOTA_PATCH_PER_PROFILE, 0),
  'generation.failuresConsumeQuota': {
    type: 'bool',
    label: '生成失败（上游出错/超时）也扣用户次数',
    group: 'quota',
    role: 'admin',
    env: () => process.env.GENERATION_FAILURES_CONSUME_QUOTA === 'true',
    default: false
  },
  'generation.patchCountsDaily': {
    type: 'bool',
    label: '局部调整计入全站每日上限',
    group: 'quota',
    role: 'admin',
    env: () => true,
    default: true
  },
  'cost.dailyLimitUsd': {
    type: 'number',
    label: '每日成本上限（USD；0 = 未设）',
    group: 'quota',
    role: 'admin',
    min: 0,
    max: 100000,
    env: () => envNumber('COST_DAILY_LIMIT_USD', 0, { min: 0, integer: false }),
    default: 0
  },
  'cost.capMode': {
    type: 'enum',
    label: '成本上限拦截',
    group: 'quota',
    role: 'admin',
    values: ['auto', 'on', 'off'],
    env: () => (['auto', 'on', 'off'].includes(String(process.env.COST_CAP_MODE)) ? String(process.env.COST_CAP_MODE) : 'auto'),
    default: 'auto'
  },
  'enrich.enabled': { type: 'bool', label: '联网核对开关', group: 'enrich', role: 'admin', env: () => ENRICH_ENABLED, default: false },
  'enrich.model': { type: 'string', label: '核对模型', group: 'enrich', role: 'admin', env: () => ENRICH_MODEL, default: 'grok-4.7' },
  'enrich.maxSearchesPerRun': {
    type: 'int',
    label: '每本路书最多联网查询次数（地点×字段）',
    group: 'enrich',
    role: 'admin',
    min: 0,
    max: 50,
    env: () => ENRICH_MAX_SEARCHES_PER_ROUTEBOOK,
    default: 12
  },
  'enrich.baseUrl': { type: 'url', label: '核对 base URL（空 = 用 env）', group: 'enrich', role: 'admin', env: () => ENRICH_BASE_URL, default: '' },
  'enrich.concurrency': { type: 'int', label: '核对并发', group: 'enrich', role: 'admin', min: 1, max: 10, env: () => ENRICH_CONCURRENCY, default: 2 },
  'enrich.maxStopsPerRun': int('每本路书最多查几个站（0 = 不限）', 'enrich', 0, 100, () => envNumber('ENRICH_MAX_STOPS_PER_ROUTEBOOK', 0, { min: 0 }), 0),
  'enrich.requireTwoSources': {
    type: 'bool',
    label: '必须两个独立来源一致才填入（关掉要二次确认）',
    group: 'enrich',
    role: 'admin',
    confirmOff: true,
    env: () => true,
    default: true
  },
  'enrich.dailyBudgetUsd': {
    type: 'number',
    label: '核对日预算（USD）',
    group: 'enrich',
    role: 'admin',
    min: 0,
    max: 100000,
    env: () => ENRICH_DAILY_BUDGET_USD,
    default: 30
  },
  'enrich.budgetAlertRatio': {
    type: 'number',
    label: '核对预算告警比例',
    group: 'enrich',
    role: 'admin',
    min: 0.1,
    max: 1,
    env: () => ENRICH_BUDGET_ALERT_RATIO,
    default: 0.8
  },
  'enrich.verifiedFactDays': int('人工核实值有效期（天）', 'enrich', 1, 3650, () => 90, 90),
  'admin.sessionIdleMinutes': int('后台登录空闲失效（分钟）', 'admin', 5, 480, () => 30, 30),
  'admin.lockoutAttempts': int('连续输错几次锁定', 'admin', 3, 20, () => 5, 5),
  'admin.lockoutMinutes': int('锁定时长（分钟）', 'admin', 1, 1440, () => 15, 15),
  'admin.testRunsPerHour': int('每个管理员每小时试跑次数', 'admin', 1, 100, () => 10, 10),
  'admin.operatorQuotaMax': int('运营单人改额度上限', 'admin', 0, 1000, () => 20, 20)
};

/** Write-only secrets: encrypted in DB, never returned. Env stays the fallback. */
export const SECRET_SCHEMA = {
  'provider.fast.apiKey': { label: '轻快档 API Key', env: () => String(process.env.OPENAI_API_KEY ?? '').trim(), model: true },
  'provider.deep.apiKey': { label: '细品档 API Key', env: () => String(process.env.OPENAI_API_KEY ?? '').trim(), model: true },
  'enrich.apiKey': { label: '核对 API Key', env: () => String(process.env.ENRICH_API_KEY ?? process.env.OPENAI_API_KEY ?? '').trim() }
};

/** Validates one value; throws ConfigValueError. Returns the normalized value. */
export function parseSetting(key, value) {
  const spec = RUNTIME_SCHEMA[key];
  if (!spec) throw new ConfigValueError(key, '不是可配置项');
  switch (spec.type) {
    case 'enum':
      if (!spec.values.includes(value)) throw new ConfigValueError(key, `只能是 ${spec.values.join(' / ')}`);
      return value;
    case 'bool':
      if (typeof value !== 'boolean') throw new ConfigValueError(key, '需要 true / false');
      return value;
    case 'int':
    case 'number': {
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (typeof n !== 'number' || !Number.isFinite(n) || (spec.type === 'int' && !Number.isInteger(n))) throw new ConfigValueError(key, '需要数字');
      if (n < spec.min || n > spec.max) throw new ConfigValueError(key, `范围 ${spec.min}–${spec.max}`);
      return n;
    }
    case 'url': {
      const u = String(value ?? '')
        .trim()
        .replace(/\/+$/, '');
      if (u && !URL_RE.test(u)) throw new ConfigValueError(key, '需要 http(s) 地址或留空');
      return u;
    }
    case 'string': {
      const s = String(value ?? '').trim();
      if (!s || s.length > 160 || /\s/.test(s)) throw new ConfigValueError(key, '需要 1–160 个非空白字符');
      return s;
    }
    case 'string[]': {
      if (!Array.isArray(value)) throw new ConfigValueError(key, '需要列表');
      const allowed = new Set(spec.items());
      const list = [...new Set(value.map((v) => String(v).trim()).filter(Boolean))];
      const bad = list.filter((v) => !allowed.has(v));
      if (bad.length) throw new ConfigValueError(key, `不支持：${bad.slice(0, 5).join('、')}`);
      if (key === 'generation.openCities' && !list.length) throw new ConfigValueError(key, '至少开放一个城市');
      return list;
    }
    case 'modelTier': {
      if (!value || typeof value !== 'object') throw new ConfigValueError(key, '需要对象');
      const provider = String(value.provider ?? 'openai-compatible');
      if (!PROVIDERS.includes(provider)) throw new ConfigValueError(key, `provider 只能是 ${PROVIDERS.join(' / ')}`);
      const baseUrl = String(value.baseUrl ?? '')
        .trim()
        .replace(/\/+$/, '');
      if (baseUrl && !URL_RE.test(baseUrl)) throw new ConfigValueError(key, 'baseUrl 需要 http(s) 地址');
      const model = String(value.model ?? '').trim();
      if (!model || model.length > 160 || /\s/.test(model)) throw new ConfigValueError(key, 'model 不能为空');
      const reasoningEffort = String(value.reasoningEffort ?? '')
        .trim()
        .toLowerCase();
      if (!REASONING.includes(reasoningEffort)) throw new ConfigValueError(key, `reasoningEffort 只能是 ${REASONING.filter(Boolean).join(' / ')} 或留空`);
      const timeoutMs = Number(value.timeoutMs);
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > Math.max(600000, AI_TIMEOUT_MS))
        throw new ConfigValueError(key, 'timeoutMs 范围 1000–600000');
      const idleTimeoutMs = value.idleTimeoutMs == null || value.idleTimeoutMs === '' ? Math.min(timeoutMs, 150000) : Number(value.idleTimeoutMs);
      if (!Number.isInteger(idleTimeoutMs) || idleTimeoutMs < 1000 || idleTimeoutMs > timeoutMs)
        throw new ConfigValueError(key, 'idleTimeoutMs 范围 1000–总超时');
      return { provider, baseUrl, model, reasoningEffort, timeoutMs, idleTimeoutMs };
    }
    case 'pricing': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConfigValueError(key, '需要 { 模型名: { input, output } }');
      const out = {};
      for (const [model, price] of Object.entries(value)) {
        // An empty field is "no price", never 0.
        const blank = (v) => v == null || (typeof v === 'string' && v.trim() === '');
        if (blank(price?.input) || blank(price?.output)) throw new ConfigValueError(key, `${model || '（未填模型名）'} 的输入、输出单价都要填`);
        const input = Number(price?.input);
        const output = Number(price?.output);
        if (!model.trim() || !Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0)
          throw new ConfigValueError(key, `${model} 单价无效`);
        // Where the price came from (e.g. 中继账单 2026-10) and as-of date; optional, shown in the console.
        const source = String(price?.source ?? '')
          .trim()
          .slice(0, 120);
        const asOf = String(price?.asOf ?? '').trim();
        if (asOf && !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new ConfigValueError(key, `${model} 单价日期格式 YYYY-MM-DD`);
        out[model.trim()] = { input, output, ...(source ? { source } : {}), ...(asOf ? { asOf } : {}) };
      }
      return out;
    }
    default:
      throw new ConfigValueError(key, '未知类型');
  }
}

/** Env value, validated; falls back to the safe default when the env value would not pass. */
export function envSetting(key) {
  const spec = RUNTIME_SCHEMA[key];
  try {
    return parseSetting(key, spec.env());
  } catch {
    return spec.default;
  }
}

export { ConfigValueError };

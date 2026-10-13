// Whitelist of runtime-configurable settings (docs/admin.md, build design §1.2).
// Effective value = parse(DB override) ?? parse(env) ?? safe default. Env values come from
// server/config/index.mjs, which already parsed/clamped them at startup, so env stays the fallback.
// No new dependency: a tiny hand-written validator in the style of envNumber().
import {
  AI_TIMEOUT_MS,
  ENRICH_CONCURRENCY,
  ENRICH_ENABLED,
  ENRICH_MAX_SEARCHES_PER_ROUTEBOOK,
  ENRICH_MODEL,
  GENERATION_DAILY_LIMIT,
  GENERATION_MODES,
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
  timeoutMs: GENERATION_MODES[key].timeoutMs
});

/**
 * @typedef {{ type: string, label: string, group: string, role: 'admin'|'operator', env: () => any, default: any,
 *   values?: string[], min?: number, max?: number, items?: () => string[], secret?: boolean, locked?: boolean,
 *   model?: boolean, help?: string }} SettingSpec
 * @type {Record<string, SettingSpec>}
 */
export const RUNTIME_SCHEMA = {
  'model.fast': { type: 'modelTier', label: '轻快档模型', group: 'model', role: 'admin', model: true, env: () => envTier('fast'), default: null },
  'model.deep': { type: 'modelTier', label: '细品档模型', group: 'model', role: 'admin', model: true, env: () => envTier('deep'), default: null },
  'model.fallbackOrder': {
    type: 'string[]',
    label: '模型兜底顺序（所选档位没配好时依次尝试）',
    group: 'model',
    role: 'admin',
    items: () => ['fast', 'deep'],
    env: () => [],
    default: []
  },
  'model.pricing': {
    type: 'pricing',
    label: '模型单价（USD / 百万 token，按服务商账单手填；不填则成本记为「未知」）',
    group: 'model',
    role: 'admin',
    env: () => ({}),
    default: {}
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
    label: '首页推荐城市（须在开放城市内；空 = 用前端默认）',
    group: 'cities',
    role: 'admin',
    items: () => ALL_CITIES,
    env: () => [],
    default: []
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
    label: '每日成本上限（USD，看板对比用；0 = 未设）',
    group: 'quota',
    role: 'admin',
    min: 0,
    max: 100000,
    env: () => envNumber('COST_DAILY_LIMIT_USD', 0, { min: 0, integer: false }),
    default: 0
  },
  'enrich.enabled': { type: 'bool', label: '联网补全开关', group: 'enrich', role: 'admin', env: () => ENRICH_ENABLED, default: false },
  'enrich.model': { type: 'string', label: '补全模型', group: 'enrich', role: 'admin', env: () => ENRICH_MODEL, default: 'grok-4.7' },
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
  'enrich.concurrency': { type: 'int', label: '补全并发', group: 'enrich', role: 'admin', min: 1, max: 10, env: () => ENRICH_CONCURRENCY, default: 2 },
  'enrich.requireTwoSources': {
    type: 'bool',
    label: '必须两个独立来源一致才填入（一期锁定为开）',
    group: 'enrich',
    role: 'admin',
    locked: true,
    env: () => true,
    default: true
  }
};

/** Write-only secrets: encrypted in DB, never returned. Env stays the fallback. */
export const SECRET_SCHEMA = {
  'provider.fast.apiKey': { label: '轻快档 API Key', env: () => String(process.env.OPENAI_API_KEY ?? '').trim(), model: true },
  'provider.deep.apiKey': { label: '细品档 API Key', env: () => String(process.env.OPENAI_API_KEY ?? '').trim(), model: true },
  'enrich.apiKey': { label: '补全 API Key', env: () => String(process.env.ENRICH_API_KEY ?? process.env.OPENAI_API_KEY ?? '').trim() }
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
      if (spec.locked && value !== spec.default) throw new ConfigValueError(key, '一期锁定，不能修改');
      return value;
    case 'int':
    case 'number': {
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (typeof n !== 'number' || !Number.isFinite(n) || (spec.type === 'int' && !Number.isInteger(n))) throw new ConfigValueError(key, '需要数字');
      if (n < spec.min || n > spec.max) throw new ConfigValueError(key, `范围 ${spec.min}–${spec.max}`);
      return n;
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
      const baseUrl = String(value.baseUrl ?? '').trim().replace(/\/+$/, '');
      if (baseUrl && !URL_RE.test(baseUrl)) throw new ConfigValueError(key, 'baseUrl 需要 http(s) 地址');
      const model = String(value.model ?? '').trim();
      if (!model || model.length > 160 || /\s/.test(model)) throw new ConfigValueError(key, 'model 不能为空');
      const reasoningEffort = String(value.reasoningEffort ?? '').trim().toLowerCase();
      if (!REASONING.includes(reasoningEffort)) throw new ConfigValueError(key, `reasoningEffort 只能是 ${REASONING.filter(Boolean).join(' / ')} 或留空`);
      const timeoutMs = Number(value.timeoutMs);
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > Math.max(600000, AI_TIMEOUT_MS)) throw new ConfigValueError(key, 'timeoutMs 范围 1000–600000');
      return { provider, baseUrl, model, reasoningEffort, timeoutMs };
    }
    case 'pricing': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConfigValueError(key, '需要 { 模型名: { input, output } }');
      const out = {};
      for (const [model, price] of Object.entries(value)) {
        const input = Number(price?.input);
        const output = Number(price?.output);
        if (!model.trim() || !Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) throw new ConfigValueError(key, `${model} 单价无效`);
        out[model.trim()] = { input, output };
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

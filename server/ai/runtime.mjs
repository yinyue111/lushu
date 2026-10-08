// Model runtime resolution (OpenAI-compatible endpoint + key).
//
// H6: reading the operator's personal Codex CLI config (~/.codex/config.toml and
// auth.json) is now opt-in. It defaults to on only for local development and
// can be forced with AI_RUNTIME_FROM_CODEX=true|false. Results are cached and
// only re-read when the Codex files change, instead of on every request.
import { readFile, stat } from 'node:fs/promises';

const DEFAULT_MODEL = 'gpt-5.5';
const SUPPORTED_WIRE_APIS = new Set(['responses', 'chat_completions']);

/** @param {string | undefined} value */
function stripQuotes(value) {
  return value?.replace(/^["']|["']$/g, '').trim();
}

/**
 * Minimal TOML subset parser for the Codex CLI config.
 * @param {string} text
 */
export function parseCodexConfig(text) {
  /** @type {{ modelProvider: string, model: string, providers: Record<string, Record<string, string>> }} */
  const config = {
    modelProvider: 'openai',
    model: DEFAULT_MODEL,
    providers: {}
  };
  let section = '';

  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const sectionMatch = line.match(/^\[(.+)]$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      continue;
    }

    const keyMatch = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/);
    if (!keyMatch) continue;

    const [, key, rawValue] = keyMatch;
    const value = stripQuotes(rawValue) ?? '';
    if (!section) {
      if (key === 'model_provider') config.modelProvider = value;
      if (key === 'model') config.model = value;
      continue;
    }

    const providerMatch = section.match(/^model_providers\.([A-Za-z0-9_-]+)$/);
    if (providerMatch) {
      const providerName = providerMatch[1];
      config.providers[providerName] ??= {};
      config.providers[providerName][key] = value;
    }
  }

  return config;
}

/**
 * @typedef {{
 *   providerName: string,
 *   model: string,
 *   wireApi: string,
 *   baseUrl: string | undefined,
 *   apiKey: string | undefined,
 *   ready: boolean,
 *   readyReason: string,
 *   codexConfigUsed: boolean,
 *   configPath: string,
 *   authPath: string
 * }} ModelRuntime
 */

/**
 * Pure resolution from env + (optional) parsed Codex files.
 * @param {{ env: Record<string, string | undefined>, codexConfigText?: string, codexAuth?: Record<string, any>, readCodex: boolean, configPath: string, authPath: string }} input
 * @returns {ModelRuntime}
 */
export function resolveModelRuntime({ env, codexConfigText = '', codexAuth = {}, readCodex, configPath, authPath }) {
  const codexConfig = parseCodexConfig(readCodex ? codexConfigText : '');
  // Without a Codex file parseCodexConfig('') yields provider "openai" / DEFAULT_MODEL,
  // matching the historical behaviour.
  const providerName = env.AI_PROVIDER ?? codexConfig.modelProvider;
  const provider = readCodex ? (codexConfig.providers[providerName] ?? {}) : {};
  const auth = readCodex ? (codexAuth ?? {}) : {};

  const baseUrl = env.OPENAI_BASE_URL ?? provider.base_url;
  const apiKey = env.OPENAI_API_KEY ?? auth.OPENAI_API_KEY;
  const model = env.OPENAI_MODEL ?? codexConfig.model;
  const wireApi = env.OPENAI_WIRE_API ?? provider.wire_api ?? 'responses';
  const supportsWireApi = SUPPORTED_WIRE_APIS.has(wireApi);

  const reasons = [];
  if (!baseUrl) reasons.push('OPENAI_BASE_URL 未配置');
  if (!apiKey) reasons.push('OPENAI_API_KEY 未配置');
  if (!supportsWireApi) reasons.push(`暂不支持 wire_api=${wireApi}`);
  if (reasons.length && !readCodex && (!baseUrl || !apiKey)) {
    reasons.push('（未读取 ~/.codex 配置；如需使用请设置 AI_RUNTIME_FROM_CODEX=true）');
  }

  return {
    providerName,
    model,
    wireApi,
    baseUrl,
    apiKey,
    ready: Boolean(baseUrl && apiKey && supportsWireApi),
    readyReason: reasons.join('；'),
    codexConfigUsed: readCodex,
    configPath,
    authPath
  };
}

async function fileFingerprint(path) {
  try {
    const stats = await stat(path);
    return `${stats.mtimeMs}:${stats.size}`;
  } catch {
    return 'missing';
  }
}

async function readOptionalText(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Creates a cached runtime loader.
 * @param {{ env?: Record<string, string | undefined>, readCodex: boolean, configPath: string, authPath: string }} options
 * @returns {() => Promise<ModelRuntime>}
 */
export function createModelRuntimeLoader({ env = process.env, readCodex, configPath, authPath }) {
  /** @type {{ fingerprint: string, runtime: ModelRuntime } | null} */
  let cache = null;
  return async function loadModelRuntime() {
    const fingerprint = readCodex ? `${await fileFingerprint(configPath)}|${await fileFingerprint(authPath)}` : 'env-only';
    if (cache && cache.fingerprint === fingerprint) return cache.runtime;
    let codexConfigText = '';
    let codexAuth = {};
    if (readCodex) {
      codexConfigText = await readOptionalText(configPath);
      try {
        codexAuth = JSON.parse((await readOptionalText(authPath)) || '{}');
      } catch {
        codexAuth = {};
      }
    }
    const runtime = resolveModelRuntime({ env, codexConfigText, codexAuth, readCodex, configPath, authPath });
    cache = { fingerprint, runtime };
    return runtime;
  };
}

/** @param {string | undefined | null} baseUrl */
export function redactBaseUrl(baseUrl) {
  if (!baseUrl) return null;
  try {
    const url = new URL(baseUrl);
    return `${url.protocol}//${url.host}`;
  } catch {
    return '[configured]';
  }
}

// Derived views over the runtime config snapshot, shared by routes and services.
import { GENERATION_MODES, resolveGenerationMode } from './index.mjs';
import { getConfig, getSecret, secretSource } from './runtime.mjs';
import { normalizeCityLabel } from '../../src/lib/chinaCities.js';

export const openCities = () => getConfig('generation.openCities');
export function isCityOpen(city) {
  const label = normalizeCityLabel(String(city ?? ''));
  return Boolean(label) && openCities().includes(label);
}
/** Recommended cities on the home page: only those inside the open range (成都/北京/广州 etc. drop out). */
export function homeCities() {
  const open = new Set(openCities());
  return getConfig('generation.homeCities').filter((city) => open.has(city));
}

/**
 * Effective settings of a generation mode: env-derived GENERATION_MODES overlaid with the admin tier.
 * @param {string} mode
 */
export function generationModeConfig(mode) {
  const key = resolveGenerationMode(mode);
  const base = GENERATION_MODES[key];
  const tier = getConfig(`model.${key}`);
  if (!tier) return { ...base };
  return {
    ...base,
    model: tier.model,
    timeoutMs: tier.timeoutMs,
    idleTimeoutMs: tier.idleTimeoutMs ?? base.idleTimeoutMs,
    reasoningEffort: tier.reasoningEffort,
    baseUrl: tier.baseUrl,
    provider: tier.provider
  };
}

/**
 * Model runtime for a mode: base runtime (env/Codex) overlaid with the admin tier's base URL, key and model.
 * @param {any} baseRuntime
 * @param {string} mode
 */
export function runtimeForMode(baseRuntime, mode) {
  const key = resolveGenerationMode(mode);
  const cfg = /** @type {any} */ (generationModeConfig(key));
  const apiKey = getSecretIfDb(`provider.${key}.apiKey`) || baseRuntime.apiKey;
  const baseUrl = cfg.baseUrl || baseRuntime.baseUrl;
  const model = cfg.model || baseRuntime.model;
  const ready = Boolean(baseUrl && apiKey) && !String(baseRuntime.readyReason ?? '').includes('wire_api');
  return { ...baseRuntime, apiKey, baseUrl, model, ready, readyReason: ready ? '' : baseRuntime.readyReason || '模型未配置', mode: key };
}

// Only a DB-stored key overrides; otherwise the base runtime's key (env / Codex auth) stays.
const getSecretIfDb = (key) => (secretSource(key) === 'db' ? getSecret(key) : '');

/**
 * Mode to actually use: the requested one when ready, else the first ready mode in model.fallbackOrder.
 * @returns {{ mode: string, runtime: any, fellBackFrom: string }}
 */
export function pickRuntime(baseRuntime, requestedMode) {
  const requested = resolveGenerationMode(requestedMode);
  const first = runtimeForMode(baseRuntime, requested);
  if (first.ready) return { mode: requested, runtime: first, fellBackFrom: '' };
  for (const candidate of getConfig('model.fallbackOrder')) {
    if (candidate === requested) continue;
    const runtime = runtimeForMode(baseRuntime, candidate);
    if (runtime.ready) return { mode: candidate, runtime, fellBackFrom: requested };
  }
  return { mode: requested, runtime: first, fellBackFrom: '' };
}

/**
 * Fallback mode used when the requested mode's upstream fails: the first other mode in
 * model.fallbackOrder. '' when upstream fallback is off or nothing qualifies.
 * @param {string} requested
 */
export function fallbackModeFor(requested) {
  if (!getConfig('model.fallbackOnUpstreamError')) return '';
  // Readiness is checked when the fallback run starts; an unconfigured fallback just reports the original error.
  return getConfig('model.fallbackOrder').find((candidate) => candidate !== resolveGenerationMode(requested)) ?? '';
}

/** Whole-job budget: the mode's own timeout plus the fallback mode's when an upstream fallback is possible. */
export function generationBudgetMs(mode) {
  const own = generationModeConfig(mode).timeoutMs;
  const fallback = fallbackModeFor(mode);
  return fallback ? own + generationModeConfig(fallback).timeoutMs : own;
}

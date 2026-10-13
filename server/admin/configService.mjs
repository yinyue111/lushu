// Runtime config writes: validate → diff → (model test-run gate) → new version → NOTIFY → refresh → audit.
// Restore = copy an old version into a NEW version (the audit chain never breaks).
import { createHash } from 'node:crypto';
import { AI_LOG_PATH } from '../config/index.mjs';
import { RUNTIME_SCHEMA, SECRET_SCHEMA, parseSetting } from '../config/runtimeSchema.mjs';
import { currentSnapshot, decryptSecret, encryptSecret, getConfig, getSecret, refreshConfig, secretFingerprint, secretSource, buildSnapshot } from '../config/runtime.mjs';
import { generationModeConfig } from '../config/runtimeViews.mjs';
import { adminStore } from './store.mjs';
import { adminAudit } from './audit.mjs';
import { createHttpError, cryptoRandomId } from './util.mjs';
import { APP_COMMIT } from '../ops/systemInfo.mjs';
import { appendJsonLine } from '../storage/jsonl.mjs';
import { estimateModelCost, summarizeModelUsage } from '../analytics/aiObservability.mjs';
import { modelPricingFor } from './cost.mjs';

const TEST_RUN_VALID_MS = 10 * 60 * 1000;
const sha = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

function requireReason(reason) {
  const text = String(reason ?? '').trim();
  if (text.length < 4) throw createHttpError('请写明原因（至少 4 个字）', 400, 'ADMIN_REASON_REQUIRED');
  return text.slice(0, 300);
}

/** What the config page shows. Secrets: only state + who/when, never a value or fingerprint. */
export async function configView() {
  const snap = currentSnapshot();
  const settings = Object.entries(RUNTIME_SCHEMA).map(([key, spec]) => ({
    key,
    label: spec.label,
    group: spec.group,
    type: spec.type,
    ...(spec.values ? { values: spec.values } : {}),
    ...(spec.items ? { items: spec.items() } : {}),
    ...(spec.min != null ? { min: spec.min, max: spec.max } : {}),
    ...(spec.confirmOff ? { confirmOff: true } : {}),
    envValue: buildSnapshot(null).values[key],
    value: snap.values[key],
    source: key in snap.overrides ? 'db' : 'env'
  }));
  const versions = await adminStore().listConfigVersions(200).catch(() => []);
  const secrets = Object.entries(SECRET_SCHEMA).map(([key, spec]) => {
    const last = versions.find((v) => (v.changes ?? []).some((c) => c.key === key));
    return { key, label: spec.label, state: secretSource(key), updatedAt: last?.createdAt ?? null, updatedBy: last?.actor ?? null };
  });
  return { version: snap.version, source: snap.source, stale: snap.stale, error: snap.error, settings, secrets };
}

/** Normalizes a patch and computes the diff without saving (the "改前 → 改后" preview). */
export function previewConfig({ values = {}, secrets = {} } = {}, snap = currentSnapshot()) {
  const overrides = { ...snap.overrides };
  const changes = [];
  for (const [key, raw] of Object.entries(values ?? {})) {
    if (!RUNTIME_SCHEMA[key]) throw createHttpError(`${key} 不是可配置项`, 400, 'ADMIN_CONFIG_UNKNOWN_KEY');
    const before = snap.values[key];
    if (raw === null) {
      if (!(key in overrides)) continue;
      delete overrides[key]; // back to env default
    } else {
      overrides[key] = parseSetting(key, raw);
    }
    const after = raw === null ? buildSnapshot(null).values[key] : overrides[key];
    if (JSON.stringify(before) !== JSON.stringify(after)) changes.push({ key, before, after, ...(raw === null ? { revertedToEnv: true } : {}) });
  }
  if (overrides['generation.homeCities']) {
    const open = new Set(overrides['generation.openCities'] ?? snap.values['generation.openCities']);
    const outside = overrides['generation.homeCities'].filter((c) => !open.has(c));
    if (outside.length) throw createHttpError(`首页推荐城市只能从开放城市里选：${outside.join('、')} 不在开放范围内`, 400, 'ADMIN_CONFIG_INVALID');
  }
  const secretEnc = { ...snap.secrets };
  for (const [key, raw] of Object.entries(secrets ?? {})) {
    if (!SECRET_SCHEMA[key]) throw createHttpError(`${key} 不是可配置密钥`, 400, 'ADMIN_CONFIG_UNKNOWN_KEY');
    const before = secretSource(key) === 'unset' ? '未设置' : '已设置';
    if (raw === null) {
      if (!secretEnc[key]) continue;
      delete secretEnc[key];
      changes.push({ key, secret: true, before, after: '已清除（回到 env）' });
    } else {
      const text = String(raw).trim();
      if (text.length < 8 || text.length > 400 || /\s/.test(text)) throw createHttpError(`${SECRET_SCHEMA[key].label} 格式不对`, 400, 'ADMIN_CONFIG_INVALID');
      secretEnc[key] = encryptSecret(text);
      changes.push({ key, secret: true, before, after: '已替换' });
    }
  }
  return { overrides, secretEnc, changes };
}

const tierOfChange = (c) => (/^model\.(fast|deep)$/.test(c.key) ? c.key.split('.')[1] : /^provider\.(fast|deep)\.apiKey$/.test(c.key) ? c.key.split('.')[1] : null);

/** Hash of what a test-run must have exercised: the draft tier settings + key fingerprint. */
export function draftHash(tier, tierSettings, apiKey) {
  return sha({ tier, tierSettings, key: apiKey ? createHash('sha256').update(apiKey).digest('hex') : '' });
}

function draftTier(tier, overrides, secretEnc) {
  const settings = overrides[`model.${tier}`] ?? generationModeConfig(tier);
  const enc = secretEnc[`provider.${tier}.apiKey`];
  return { settings, enc };
}

/**
 * @param {{ admin: any, req: any, values?: any, secrets?: any, reason: string, testRunIds?: string[], force?: boolean, confirmTwoSourceOff?: boolean }} input
 */
export async function saveConfig({ admin, req, values, secrets, reason, testRunIds = [], force = false, confirmTwoSourceOff = false }) {
  const why = requireReason(reason);
  await refreshConfig();
  const snap = currentSnapshot();
  if (snap.stale) throw createHttpError('配置库暂时连不上，现在不能保存', 503, 'ADMIN_CONFIG_DB_UNAVAILABLE');
  const { overrides, secretEnc, changes } = previewConfig({ values, secrets }, snap);
  if (!changes.length) throw createHttpError('没有改动', 400, 'ADMIN_CONFIG_NO_CHANGES');
  const twoSourceOff = changes.find((c) => c.key === 'enrich.requireTwoSources' && c.after === false);
  if (twoSourceOff && !confirmTwoSourceOff) throw createHttpError('关闭「两来源一致」会让只有一个来源的值也显示出来，请二次确认', 409, 'ADMIN_CONFIRM_REQUIRED');

  // Model change gate: a successful test-run of the same draft within 10 minutes, or an admin force-save with reason.
  const tiers = [...new Set(changes.map(tierOfChange).filter(Boolean))];
  let forced = false;
  if (tiers.length) {
    const runs = (await adminStore().listAudit({ limit: 500, action: 'config.test-run' })).filter((e) => testRunIds.includes(e.detail?.testRunId));
    for (const tier of tiers) {
      const { settings, enc } = draftTier(tier, overrides, secretEnc);
      const key = enc ? decryptSecret(enc) : getSecret(`provider.${tier}.apiKey`);
      const hash = draftHash(tier, settings, key);
      const ok = runs.some((e) => e.detail?.draftHash === hash && e.detail?.ok === true && Date.now() - Date.parse(e.createdAt) < TEST_RUN_VALID_MS);
      if (!ok) {
        if (!force) throw createHttpError(`改${tier === 'fast' ? '轻快' : '细品'}档模型前需要一次成功的试跑（10 分钟内，同一份草稿）`, 409, 'ADMIN_TEST_RUN_REQUIRED');
        if (admin.role !== 'admin') throw createHttpError('只有管理员能强制保存', 403, 'ADMIN_FORBIDDEN');
        forced = true;
      }
    }
  }
  const entry = await adminStore().insertConfigVersion({ overrides, secrets: secretEnc, changes, actor: admin.username, note: why }, snap.version);
  await adminStore().notifyConfigChanged(entry.version);
  await refreshConfig();
  await adminAudit(req, { admin, action: 'config.save', target: `config:v${entry.version}`, before: changes.map((c) => ({ key: c.key, value: c.before })), after: changes.map((c) => ({ key: c.key, value: c.after })), reason: why, extra: { version: entry.version, ...(forced ? { forcedWithoutTestRun: true } : {}), ...(twoSourceOff ? { twoSourceOffConfirmed: true } : {}) } });
  return { version: entry.version, changes, forced };
}


export async function restoreConfig({ admin, req, version, reason }) {
  const why = requireReason(reason);
  await refreshConfig();
  const snap = currentSnapshot();
  const target = await adminStore().getConfigVersion(Number(version));
  if (!target) throw createHttpError('没有这个版本', 404, 'ADMIN_CONFIG_VERSION_NOT_FOUND');
  const next = buildSnapshot({ ...target, version: snap.version + 1 }); // validates the old snapshot against today's schema
  const changes = [];
  for (const key of Object.keys(RUNTIME_SCHEMA)) {
    if (JSON.stringify(snap.values[key]) !== JSON.stringify(next.values[key])) changes.push({ key, before: snap.values[key], after: next.values[key] });
  }
  for (const key of Object.keys(SECRET_SCHEMA)) {
    if ((snap.secrets[key] ?? '') !== (next.secrets[key] ?? '')) changes.push({ key, secret: true, before: snap.secrets[key] ? '已设置' : '未设置', after: next.secrets[key] ? '恢复为旧值' : '已清除（回到 env）' });
  }
  const entry = await adminStore().insertConfigVersion({ overrides: target.overrides, secrets: target.secrets, changes, actor: admin.username, note: why, restoredFrom: target.version }, snap.version);
  await adminStore().notifyConfigChanged(entry.version);
  await refreshConfig();
  await adminAudit(req, { admin, action: 'config.restore', target: `config:v${entry.version}`, before: changes.map((c) => ({ key: c.key, value: c.before })), after: changes.map((c) => ({ key: c.key, value: c.after })), reason: why, extra: { restoredFrom: target.version, version: entry.version } });
  return { version: entry.version, restoredFrom: target.version, changes };
}

export async function listVersions() {
  return (await adminStore().listConfigVersions(100)).map(({ version, changes, actor, note, restoredFrom, createdAt }) => ({ version, changes, actor, note, restoredFrom, createdAt }));
}

/** Export (build design §3): secrets → { redacted, fingerprint }. Carries commit + image id for deploy records. */
export async function exportConfig(version) {
  const entry = version ? await adminStore().getConfigVersion(Number(version)) : await adminStore().latestConfig();
  return {
    format: 'lushu-runtime-config',
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    commit: APP_COMMIT,
    imageDigest: String(process.env.APP_IMAGE_DIGEST ?? '').trim() || 'unknown',
    version: entry?.version ?? 0,
    createdAt: entry?.createdAt ?? null,
    actor: entry?.actor ?? null,
    note: entry?.note ?? '',
    overrides: entry?.overrides ?? {},
    secrets: Object.fromEntries(Object.entries(entry?.secrets ?? {}).map(([key, enc]) => [key, { redacted: true, fingerprint: secretFingerprint(enc) }]))
  };
}

// ---------------------------------------------------------------- model test-run
let modelTester = defaultModelTester;
export function setModelTesterForTests(fn) {
  modelTester = fn ?? defaultModelTester;
}

async function defaultModelTester({ baseUrl, apiKey, model, wireApi, reasoningEffort, timeoutMs }) {
  const { openAiEndpoint } = await import('../ai/generate.mjs');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 60000));
  // Fixed tiny prompt: proves URL / key / model work, costs a few hundred tokens.
  const prompt = '只回复 JSON：{"ok":true,"city":"杭州"}';
  const body =
    wireApi === 'chat_completions'
      ? { model, messages: [{ role: 'user', content: prompt }], max_tokens: 64, ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}) }
      : { model, input: prompt, max_output_tokens: 64, ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}) };
  try {
    const response = await fetch(openAiEndpoint(baseUrl, wireApi), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, usage: data?.usage ?? null, error: response.ok ? '' : `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, status: 0, usage: null, error: error?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs the draft tier once. Rate-limited per admin (admin.testRunsPerHour, counted from the audit table so it
 * holds across processes). Logged to ai-logs with purpose admin_test: counts toward today's cost, not user quota.
 */
export async function testRunModel({ admin, req, tier, draft, apiKey = '' }) {
  if (!['fast', 'deep'].includes(tier)) throw createHttpError('档位只能是 fast 或 deep', 400, 'ADMIN_TIER_INVALID');
  const settings = parseSetting(`model.${tier}`, draft ?? generationModeConfig(tier));
  const hourAgo = Date.now() - 3600000;
  const recent = (await adminStore().listAudit({ limit: 500, action: 'config.test-run' })).filter((e) => e.actor === admin.username && Date.parse(e.createdAt) > hourAgo);
  const limit = getConfig('admin.testRunsPerHour');
  if (recent.length >= limit) {
    const oldest = Math.min(...recent.map((e) => Date.parse(e.createdAt)));
    const wait = Math.max(1, Math.ceil((oldest + 3600000 - Date.now()) / 60000));
    throw Object.assign(createHttpError(`试跑每小时最多 ${limit} 次，请 ${wait} 分钟后再试`, 429, 'ADMIN_TEST_RUN_LIMIT'), { retryAfterSeconds: wait * 60 });
  }
  const { loadCodexRuntime } = await import('../ai/generate.mjs');
  const base = await loadCodexRuntime();
  const key = String(apiKey || '').trim() || getSecret(`provider.${tier}.apiKey`) || base.apiKey || '';
  const baseUrl = settings.baseUrl || base.baseUrl || '';
  const startedAt = Date.now();
  const result = baseUrl && key ? await modelTester({ baseUrl, apiKey: key, model: settings.model, wireApi: base.wireApi ?? 'responses', reasoningEffort: settings.reasoningEffort, timeoutMs: settings.timeoutMs }) : { ok: false, usage: null, error: 'NOT_CONFIGURED' };
  const durationMs = Date.now() - startedAt;
  const u = result.usage;
  const modelUsage = summarizeModelUsage([{ usage: u ? { input_tokens: u.input_tokens ?? u.prompt_tokens, output_tokens: u.output_tokens ?? u.completion_tokens, total_tokens: u.total_tokens } : null }]);
  const costEstimate = estimateModelCost({ modelUsage, model: settings.model, config: modelPricingFor(settings.model) });
  const testRunId = `tr_${cryptoRandomId()}`;
  await appendJsonLine(AI_LOG_PATH, { requestId: testRunId, kind: 'admin-test-run', purpose: 'admin_test', mode: tier, model: settings.model, status: result.ok ? 'ok' : 'error', code: result.ok ? '' : result.error, durationMs, modelUsage, costEstimate, createdAt: new Date().toISOString() });
  const hash = draftHash(tier, settings, key);
  await adminAudit(req, { admin, action: 'config.test-run', target: `model.${tier}`, extra: { testRunId, draftHash: hash, ok: result.ok, model: settings.model, durationMs, error: result.error || '', cost: costEstimate.status === 'estimated' ? costEstimate.amount : null } });
  return { testRunId, ok: result.ok, durationMs, error: result.error || '', cost: costEstimate.status === 'estimated' ? { amount: costEstimate.amount, currency: costEstimate.currency } : null, remainingThisHour: limit - recent.length - 1 };
}

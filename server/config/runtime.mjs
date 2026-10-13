// Runtime config snapshot (build design §1.3/1.4). Hot path is a synchronous in-memory read.
// - DB > env > safe default, per key (runtimeSchema.mjs).
// - Startup: DB unreachable → warn and run on env defaults.
// - Running: a failed refresh keeps the last good snapshot (and raises an alert); an invalid stored
//   snapshot is rejected as a whole and the previous one stays.
// - Propagation: PostgreSQL LISTEN on a dedicated connection + a 5 s `max(version)` poll as backstop.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { IS_PRODUCTION, PROFILE_ID_SECRET } from './index.mjs';
import { envNumber } from './env.mjs';
import { RUNTIME_SCHEMA, SECRET_SCHEMA, envSetting, parseSetting } from './runtimeSchema.mjs';

export const CONFIG_POLL_MS = envNumber('ADMIN_CONFIG_POLL_MS', 5000, { min: 200, max: 60000 });
const CONFIG_ENC_KEY = String(process.env.CONFIG_ENC_KEY ?? '').trim() || (IS_PRODUCTION ? '' : `dev-only:${PROFILE_ID_SECRET}:config-enc`);

/** @typedef {{ version: number, values: Record<string, any>, overrides: Record<string, any>, secrets: Record<string, string>, source: 'env'|'db', loadedAt: string, error: string, stale: boolean }} Snapshot */

function envValues() {
  return Object.fromEntries(Object.keys(RUNTIME_SCHEMA).map((key) => [key, envSetting(key)]));
}

/** Builds a snapshot from a stored version; throws if any stored override is invalid (whole snapshot rejected). */
export function buildSnapshot(entry) {
  const values = envValues();
  const overrides = {};
  for (const [key, raw] of Object.entries(entry?.overrides ?? {})) {
    if (!RUNTIME_SCHEMA[key]) continue; // a key removed from the whitelist is ignored, not fatal
    overrides[key] = parseSetting(key, raw);
    values[key] = overrides[key];
  }
  const secrets = {};
  for (const [key, enc] of Object.entries(entry?.secrets ?? {})) if (SECRET_SCHEMA[key] && typeof enc === 'string') secrets[key] = enc;
  return { version: entry?.version ?? 0, values, overrides, secrets, source: entry ? 'db' : 'env', loadedAt: new Date().toISOString(), error: '', stale: false };
}

/** @type {Snapshot} */
let snapshot = { ...buildSnapshot(null), source: 'env' };
let storeProvider = null;
let alertFn = null;
const listeners = new Set();

export function getConfig(key) {
  if (!(key in snapshot.values)) throw new Error(`Unknown runtime config key: ${key}`);
  return snapshot.values[key];
}
export function getConfigVersion() {
  return snapshot.version;
}
export function configStatus() {
  return { version: snapshot.version, source: snapshot.source, loadedAt: snapshot.loadedAt, stale: snapshot.stale, error: snapshot.error };
}
export function currentSnapshot() {
  return snapshot;
}
/** Secret value: DB (decrypted) > env. Never sent to clients. */
export function getSecret(key) {
  const enc = snapshot.secrets[key];
  if (enc) {
    const plain = decryptSecret(enc);
    if (plain) return plain;
  }
  return SECRET_SCHEMA[key]?.env() ?? '';
}
export function secretSource(key) {
  if (snapshot.secrets[key]) return 'db';
  return SECRET_SCHEMA[key]?.env() ? 'env' : 'unset';
}
export function onConfigChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ---------------------------------------------------------------- secrets
const encKey = () => {
  if (!CONFIG_ENC_KEY) throw Object.assign(new Error('CONFIG_ENC_KEY 未配置，不能保存密钥'), { statusCode: 400, code: 'CONFIG_ENC_KEY_MISSING' });
  return createHash('sha256').update(`config-enc:v1:${CONFIG_ENC_KEY}`).digest();
};
export function encryptSecret(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encKey(), iv);
  const data = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}
export function decryptSecret(value) {
  const [version, iv, tag, data] = String(value ?? '').split('.');
  if (version !== 'v1' || !iv || !tag || !data) return '';
  try {
    const decipher = createDecipheriv('aes-256-gcm', encKey(), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}
/** Non-reversible fingerprint for exports / audit: "sha256:abcd1234". */
export function secretFingerprint(enc) {
  const plain = decryptSecret(enc);
  return plain ? `sha256:${createHash('sha256').update(plain).digest('hex').slice(0, 8)}` : 'sha256:unknown';
}

// ---------------------------------------------------------------- sync
/**
 * @param {{ store: () => any, alert?: (key: string, message: string) => unknown }} deps
 */
export function configureRuntimeConfig({ store, alert } = /** @type {any} */ ({})) {
  storeProvider = store;
  alertFn = alert ?? null;
}

function install(next) {
  const previous = snapshot;
  snapshot = next;
  if (previous.version !== next.version) for (const listener of listeners) listener(next, previous);
}

/** Pulls the newest version. Returns the active snapshot. Never throws. */
export async function refreshConfig() {
  if (!storeProvider) return snapshot;
  let latest;
  try {
    latest = await storeProvider().latestConfig();
  } catch (error) {
    const message = `配置库读取失败：${String(error?.message ?? error).slice(0, 160)}`;
    if (snapshot.source === 'db') {
      if (!snapshot.stale) void alertFn?.('admin-config-stale', `${message}；继续使用 v${snapshot.version}`);
      snapshot = { ...snapshot, stale: true, error: message };
    } else {
      if (!snapshot.error) console.warn(`[config] ${message}; running on env defaults`);
      snapshot = { ...snapshot, error: message };
    }
    return snapshot;
  }
  if (!latest) {
    if (snapshot.source !== 'env' || snapshot.error) install({ ...buildSnapshot(null) });
    return snapshot;
  }
  if (latest.version === snapshot.version && snapshot.source === 'db' && !snapshot.stale) return snapshot;
  try {
    install(buildSnapshot(latest));
  } catch (error) {
    const message = `配置 v${latest.version} 校验失败，保持 v${snapshot.version}：${error.message}`;
    if (snapshot.error !== message) void alertFn?.('admin-config-invalid', message);
    snapshot = { ...snapshot, error: message };
  }
  return snapshot;
}

let pollTimer = null;
let listenClient = null;
let stopped = true;

/** @param {{ pool?: import('pg').Pool, channel?: string, pollMs?: number }} [options] */
export async function startConfigSync({ pool, channel, pollMs = CONFIG_POLL_MS } = {}) {
  stopped = false;
  await refreshConfig();
  if (pool && channel) await connectListener(pool, channel);
  pollTimer = setInterval(() => {
    void refreshConfig();
    if (pool && channel && !listenClient && !stopped) void connectListener(pool, channel);
  }, pollMs);
  pollTimer.unref?.();
}

async function connectListener(pool, channel) {
  try {
    const client = await pool.connect();
    client.on('notification', (msg) => {
      if (msg.channel === channel) void refreshConfig();
    });
    client.on('error', () => {
      client.release(true);
      if (listenClient === client) listenClient = null;
    });
    await client.query(`listen ${channel}`);
    listenClient = client;
  } catch {
    listenClient = null; // the poll is the backstop; reconnect on the next tick
  }
}

export async function stopConfigSync() {
  stopped = true;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  const client = listenClient;
  listenClient = null;
  if (client) {
    await client.query('unlisten *').catch(() => {});
    client.release();
  }
}

/** Test hook: reset to env-only. */
export function resetRuntimeConfigForTests() {
  snapshot = buildSnapshot(null);
  storeProvider = null;
  alertFn = null;
}

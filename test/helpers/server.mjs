import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hermeticServerEnv } from '../../scripts/lib/hermetic-env.mjs';

export const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const ADMIN_TOKEN = 'unit-test-admin-token';
export const API_TOKEN = 'unit-test-api-token';
export const IDENTITY_SECRET = 'unit-test-identity-secret';

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
      server.close(() => resolve(port));
    });
  });
}

/**
 * Spawns an isolated production-mode server on a free port with a temp data dir.
 * @param {{ env?: Record<string, string>, dataDir?: string, waitFor?: 'live' | 'none', args?: string[] }} [options]
 */
export async function startServer(options = {}) {
  const port = await freePort();
  const dataDir = options.dataDir ?? await mkdtemp(join(tmpdir(), 'routebook-unit-'));
  const output = [];
  const child = spawn(process.execPath, ['server.mjs', ...(options.args ?? [])], {
    cwd: PROJECT_ROOT,
    env: hermeticServerEnv({
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: String(port),
      ROUTEBOOK_DATA_DIR: dataDir,
      ROUTEBOOK_ADMIN_TOKEN: ADMIN_TOKEN,
      ROUTEBOOK_API_TOKEN: API_TOKEN,
      ALLOW_PUBLIC_MODEL_PROXY: 'true',
      PROFILE_ID_SECRET: 'unit-test-profile-secret',
      PROFILE_IDENTITY_ASSERTION_SECRET: IDENTITY_SECRET,
      REQUIRE_LOCAL_ADMIN_TOKEN: 'true',
      RATE_LIMIT_MAX: '1000',
      RATE_LIMIT_CORE_WRITE_MAX: '1000',
      RATE_LIMIT_PUBLIC_READ_MAX: '1000',
      ...(options.env ?? {})
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  const baseUrl = `http://127.0.0.1:${port}`;
  const stop = async () => {
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGTERM');
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
    if (!options.dataDir) await rm(dataDir, { recursive: true, force: true });
  };
  if (options.waitFor !== 'none') {
    const started = Date.now();
    for (;;) {
      try {
        const response = await fetch(`${baseUrl}/api/live`);
        if (response.ok) break;
      } catch {
        // not up yet
      }
      if (child.exitCode != null || Date.now() - started > 20000) {
        await stop();
        throw new Error(`server did not start (exit=${child.exitCode}):\n${output.join('')}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return { baseUrl, port, dataDir, child, output, exited, stop };
}

/**
 * @param {string} url
 * @param {RequestInit} [init]
 */
export async function fetchJson(url, init = {}) {
  const response = await fetch(url, init);
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  return { response, status: response.status, data };
}

export const adminHeaders = (extra = {}) => ({ 'x-routebook-admin-token': ADMIN_TOKEN, ...extra });
export const jsonHeaders = (extra = {}) => ({ 'content-type': 'application/json', ...extra });

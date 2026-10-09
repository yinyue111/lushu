import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inspectSourceCoordinationLease } from '../server/storage/sourceCoordination.mjs';

const projectRoot = resolve(import.meta.dirname, '..');
const dataDir = await mkdtemp(join(tmpdir(), 'trusted-routebook-runtime-lease-'));
const processes = new Set();

try {
  const firstPort = await reservePort();
  const first = startServer(firstPort);
  await waitForHealth(firstPort, first);
  const activeLease = await inspectSourceCoordinationLease(dataDir);
  assert.equal(activeLease.state, 'active');
  assert.equal(activeLease.owner.kind, 'runtime-writer');
  assert.equal(activeLease.owner.pid, first.child.pid);

  const competingPort = await reservePort();
  const competing = startServer(competingPort);
  const competingExit = await waitForExit(competing.child, 10_000);
  processes.delete(competing.child);
  assert.notEqual(competingExit.code, 0, 'a second JSONL runtime must not share the source directory');
  assert.match(`${competing.stdout.join('')}\n${competing.stderr.join('')}`, /SOURCE_COORDINATION_LEASE_HELD/);
  assert.equal((await inspectSourceCoordinationLease(dataDir)).owner.pid, first.child.pid);

  const firstExit = await stopServer(first.child);
  processes.delete(first.child);
  assert.equal(firstExit.code, 0, `first runtime shutdown failed: ${first.stderr.join('')}`);
  assert.equal((await inspectSourceCoordinationLease(dataDir)).state, 'available');

  const successorPort = await reservePort();
  const successor = startServer(successorPort);
  await waitForHealth(successorPort, successor);
  assert.equal((await inspectSourceCoordinationLease(dataDir)).owner.pid, successor.child.pid);
  const successorExit = await stopServer(successor.child);
  processes.delete(successor.child);
  assert.equal(successorExit.code, 0, `successor runtime shutdown failed: ${successor.stderr.join('')}`);
  assert.equal((await inspectSourceCoordinationLease(dataDir)).state, 'available');

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      runtimeLeaseActive: true,
      competingRuntimeRejected: true,
      gracefulShutdownReleasedLease: true,
      successorStartedAfterRelease: true
    })}\n`
  );
} finally {
  await Promise.all([...processes].map((child) => stopServer(child).catch(() => {})));
  await rm(dataDir, { recursive: true, force: true });
}

function startServer(port) {
  const stdout = [];
  const stderr = [];
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: String(port),
      STORAGE_BACKEND: 'jsonl',
      ROUTEBOOK_DATA_DIR: dataDir,
      ROUTEBOOK_API_TOKEN: 'runtime-lease-api-token',
      ROUTEBOOK_ADMIN_TOKEN: 'runtime-lease-admin-token',
      PROFILE_ID_SECRET: 'runtime-lease-profile-secret',
      OPENAI_BASE_URL: 'http://127.0.0.1:1',
      OPENAI_API_KEY: 'runtime-lease-unused-model-key',
      OPENAI_MODEL: 'runtime-lease-unused-model',
      SHUTDOWN_TIMEOUT_MS: '2000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  processes.add(child);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  return { child, stdout, stderr };
}

async function waitForHealth(port, processResult, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processResult.child.exitCode !== null) {
      throw new Error(`runtime exited before health check: ${processResult.stderr.join('')}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch {
      // Runtime is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`runtime did not become healthy on port ${port}`);
}

async function stopServer(child) {
  if (child.exitCode !== null) return { code: child.exitCode, signal: child.signalCode };
  child.kill('SIGTERM');
  try {
    return await waitForExit(child, 8_000);
  } catch (error) {
    child.kill('SIGKILL');
    await waitForExit(child, 3_000).catch(() => {});
    throw error;
  }
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => {
      cleanup();
      rejectExit(new Error(`runtime process ${child.pid} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    const onExit = (code, signal) => {
      cleanup();
      resolveExit({ code, signal });
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off('exit', onExit);
    };
    child.once('exit', onExit);
  });
}

function reservePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const address = /** @type {import('node:net').AddressInfo} */ (server.address());
      server.close((error) => {
        if (error) rejectPort(error);
        else resolvePort(address.port);
      });
    });
  });
}

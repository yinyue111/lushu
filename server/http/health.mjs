// Readiness snapshot (/api/ready).
import { access, mkdir } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { DATA_DIR, APP_ID } from '../config/index.mjs';
import { loadCodexRuntime } from '../ai/generate.mjs';
import { usesPostgresStorage, getPostgresStorage } from '../storage/runtime.mjs';

async function checkStorageReadiness() {
  try {
    if (usesPostgresStorage()) return await getPostgresStorage().checkReadiness();
    await mkdir(DATA_DIR, { recursive: true });
    await access(DATA_DIR, fsConstants.R_OK | fsConstants.W_OK);
    return { ready: true, code: 'READY' };
  } catch {
    return { ready: false, code: 'STORAGE_NOT_READ_WRITE' };
  }
}

export async function buildReadinessSnapshot() {
  const [storage, runtimeResult] = await Promise.all([
    checkStorageReadiness(),
    loadCodexRuntime()
      .then((runtime) => ({
        ready: runtime.ready,
        code: runtime.ready ? 'READY' : 'MODEL_RUNTIME_NOT_READY'
      }))
      .catch(() => ({ ready: false, code: 'MODEL_RUNTIME_CHECK_FAILED' }))
  ]);
  const ready = storage.ready && runtimeResult.ready;
  const checks = {
    storage,
    runtime: runtimeResult
  };
  return {
    ok: ready,
    appId: APP_ID,
    ready,
    checks,
    reasonCodes: Object.values(checks)
      .filter((check) => !check.ready)
      .map((check) => check.code)
  };
}

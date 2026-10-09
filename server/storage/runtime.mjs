import { AsyncLocalStorage } from 'node:async_hooks';
import { DATA_DIR, PROFILE_ID_SECRET } from '../config/index.mjs';
import { acquireJsonlRuntimeWriterLease } from './sourceCoordination.mjs';

export const STORAGE_BACKEND = String(process.env.STORAGE_BACKEND ?? 'jsonl')
  .trim()
  .toLowerCase();
if (!['jsonl', 'postgres'].includes(STORAGE_BACKEND)) throw new Error('STORAGE_BACKEND must be jsonl or postgres');
let postgresStorage;
let writerLease;
const entityLocks = new Map();
const heldLocks = new AsyncLocalStorage();

export function usesPostgresStorage() {
  return STORAGE_BACKEND === 'postgres';
}
export function getPostgresStorage() {
  if (!postgresStorage) throw new Error('PostgreSQL storage is not initialized');
  return postgresStorage;
}

export async function initializeRuntimeStorage() {
  if (usesPostgresStorage()) {
    const { initializePostgresRuntime } = await import('../postgresAdapter.mjs');
    postgresStorage = await initializePostgresRuntime({ storageBackend: STORAGE_BACKEND, profileIdSecret: PROFILE_ID_SECRET });
  } else {
    writerLease = await acquireJsonlRuntimeWriterLease({ dataDir: DATA_DIR });
  }
}

export async function closeRuntimeStorage() {
  await postgresStorage?.close();
  await writerLease?.release();
  postgresStorage = null;
  writerLease = null;
}

// Reentrant within a logical operation; separate requests still serialize. This
// lets profile deletion and a nested trip/checkin write share the same guard.
export async function withStorageEntityLock(namespace, entityId, operation) {
  const key = `${namespace}:${entityId}`;
  const held = heldLocks.getStore() ?? new Set();
  if (held.has(key)) return operation();
  const run = () => heldLocks.run(new Set([...held, key]), operation);
  if (usesPostgresStorage()) return getPostgresStorage().withEntityMutationLock(namespace, entityId, run);
  const predecessor = entityLocks.get(key);
  /** @type {(value?: unknown) => void} */
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  entityLocks.set(key, gate);
  if (predecessor) await predecessor;
  try {
    return await run();
  } finally {
    release();
    if (entityLocks.get(key) === gate) entityLocks.delete(key);
  }
}

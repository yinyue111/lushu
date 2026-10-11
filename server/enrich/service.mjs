// Background enrichment: queue, worker, read model and "this is wrong" reports.
import {
  ENRICH_API_KEY,
  ENRICH_BASE_URL,
  ENRICH_CONCURRENCY,
  ENRICH_ENABLED,
  ENRICH_MAX_ATTEMPTS,
  ENRICH_POLL_MS,
  ENRICH_RETRY_BASE_MS
} from '../config/index.mjs';
import { cryptoRandomId } from '../auth/tokens.mjs';
import { getResolvableRoutebook } from '../routebooks/normalize.mjs';
import { enrichRoutebook, stopKeyOf } from './engine.mjs';
import { enrichStore } from './store.mjs';

const LEASE_MS = 10 * 60 * 1000;

export function enrichmentReady() {
  if (!ENRICH_ENABLED) return { ready: false, reason: 'ENRICH_ENABLED=false' };
  if (!ENRICH_BASE_URL || !ENRICH_API_KEY) return { ready: false, reason: 'ENRICH_BASE_URL / ENRICH_API_KEY（或 OPENAI_*）未配置' };
  return { ready: true, reason: '' };
}

/** Called after a logged-in user's routebook is saved. Never throws, never delays the caller. */
export async function enqueueEnrichment({ routebookId, userId }) {
  if (!routebookId || !userId || !enrichmentReady().ready) return null;
  try {
    const { job } = await enrichStore().enqueue({ routebookId, userId });
    kickWorker();
    return job;
  } catch (error) {
    console.warn('[enrich] enqueue failed', error?.message);
    return null;
  }
}

/**
 * What the client shows for a routebook: per stop + field, filled values with sources, or nothing.
 * Claims whose stop has since been renamed or removed are dropped.
 */
export async function enrichmentView(routebook) {
  const store = enrichStore();
  const id = routebook.publicId || routebook.id;
  const job = await store.getJob(id);
  if (!job) return { status: 'none', claims: [] };
  const status = job.status === 'done' ? 'done' : job.status === 'failed' || job.status === 'skipped' ? job.status : 'pending';
  const result = await store.getResult(id);
  const names = new Map((routebook.stops ?? []).map((stop, index) => [stopKeyOf(stop, index), String(stop.name ?? '').trim()]));
  const claims = (result?.claims ?? [])
    .filter((c) => c.status === 'filled' && names.get(c.stopKey) === c.stopName)
    .map(({ stopKey, stopName, field, value, display, sources, retrievedAt, method }) => ({
      stopKey,
      stopName,
      field,
      value,
      display,
      sources: (sources ?? []).map(({ url, title, domain, kind }) => ({ url, title, domain, kind })),
      retrievedAt,
      method
    }));
  return { status, claims, updatedAt: result?.updatedAt ?? job.updatedAt };
}

/** A user says an enriched value is wrong: hide it on this routebook and drop the shared cache entry. */
export async function reportEnrichment({ routebookId, stopKey, field, note = '', userId = null }) {
  const store = enrichStore();
  const result = await store.getResult(routebookId);
  const claim = result?.claims?.find((c) => c.stopKey === stopKey && c.field === field && c.status === 'filled');
  if (!claim) return { ok: false };
  await store.putResult(
    routebookId,
    result.claims.map((c) => (c === claim ? { ...c, status: 'disputed' } : c))
  );
  if (claim.cacheKey) await store.deleteCache(claim.cacheKey);
  await store.addReport({
    id: cryptoRandomId(),
    routebookId,
    stopKey,
    field,
    cacheKey: claim.cacheKey ?? '',
    note: String(note).slice(0, 300),
    userId,
    createdAt: new Date().toISOString(),
    value: claim.value
  });
  return { ok: true };
}

// ---------------------------------------------------------------- worker
let timer = null;
let running = 0;
let ticking = false;
/** @type {any} */
let workerDeps = {};

export function retryDelayMs(attempts) {
  return ENRICH_RETRY_BASE_MS * 4 ** Math.max(0, attempts - 1);
}

async function runJob(job) {
  const store = enrichStore();
  try {
    const routebook = await getResolvableRoutebook(job.routebookId);
    if (!routebook) {
      await store.updateJob(job.routebookId, { status: 'skipped', leaseUntil: null, lastError: 'routebook gone' });
      return;
    }
    const { claims, summary } = await enrichRoutebook({
      routebook,
      store,
      deps: workerDeps,
      log: (event) => console.log(JSON.stringify(event))
    });
    await store.putResult(job.routebookId, claims);
    await store.updateJob(job.routebookId, { status: 'done', leaseUntil: null, lastError: '', summary });
  } catch (error) {
    const giveUp = job.attempts >= ENRICH_MAX_ATTEMPTS || error?.retryable === false;
    await store.updateJob(job.routebookId, {
      status: giveUp ? 'failed' : 'queued',
      leaseUntil: null,
      lastError: String(error?.message ?? error).slice(0, 300),
      nextAttemptAt: new Date(Date.now() + retryDelayMs(job.attempts)).toISOString()
    });
  }
}

export async function tickEnrichment() {
  if (ticking) return 0;
  ticking = true;
  try {
    const free = ENRICH_CONCURRENCY - running;
    if (free <= 0) return 0;
    const jobs = await enrichStore().claimDue({ now: Date.now(), leaseMs: LEASE_MS, limit: free });
    for (const job of jobs) {
      running += 1;
      runJob(job).finally(() => {
        running -= 1;
        kickWorker();
      });
    }
    return jobs.length;
  } catch (error) {
    console.warn('[enrich] tick failed', error?.message);
    return 0;
  } finally {
    ticking = false;
  }
}

function kickWorker() {
  if (timer) setImmediate(() => void tickEnrichment());
}

export function startEnrichmentWorker(deps = {}) {
  const readiness = enrichmentReady();
  if (!readiness.ready) {
    if (ENRICH_ENABLED) console.warn(`[enrich] not started: ${readiness.reason}`);
    return false;
  }
  workerDeps = deps;
  if (timer) return true;
  timer = setInterval(() => void tickEnrichment(), ENRICH_POLL_MS);
  timer.unref?.();
  kickWorker();
  return true;
}

export function stopEnrichmentWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

export async function enrichmentStats() {
  return { ...(await enrichStore().stats()), ready: enrichmentReady(), running };
}

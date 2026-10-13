// Phase-1 dashboard: exactly 3 numbers (PRD P1). Definitions are in docs/admin.md §5.
import { AI_LOG_PATH } from '../config/index.mjs';
import { getConfig } from '../config/runtime.mjs';
import { readMatchingJsonLines } from '../storage/jsonl.mjs';
import { enrichStore } from '../enrich/store.mjs';
import { getSavedRoutebook } from '../storage/records.mjs';
import { stopKeyOf } from '../enrich/engine.mjs';

const DAY = 86400000;
const TZ_OFFSET_MS = 8 * 3600000; // "today" = Asia/Shanghai calendar day (UTC+8), same as the team's day
export const startOfTodayMs = (now = Date.now()) => Math.floor((now + TZ_OFFSET_MS) / DAY) * DAY - TZ_OFFSET_MS;

const rowModel = (row) => row?.model ?? row?.observability?.model ?? row?.provider?.model ?? '';
const rowCost = (row) => {
  const c = row?.costEstimate ?? row?.observability?.costEstimate;
  return c?.status === 'estimated' && Number.isFinite(c.amount) ? c.amount : null;
};

/** 1) Generation success rate: ok / (ok + error), cancelled + dedup + admin test-runs excluded; by mode, today + 7 days. */
export function successRate(rows, now = Date.now()) {
  const today = startOfTodayMs(now);
  const week = now - 7 * DAY;
  const buckets = {};
  for (const row of rows) {
    if (row.kind !== 'generate-routebook' || row.status === 'cancelled' || row.deduplicated === true) continue;
    if (row.status !== 'ok' && row.status !== 'error') continue;
    const at = Date.parse(row.createdAt ?? '');
    if (!(at >= week)) continue;
    for (const period of at >= today ? ['today', 'week'] : ['week']) {
      for (const mode of ['all', row.mode === 'deep' ? 'deep' : 'fast']) {
        const b = (buckets[`${period}.${mode}`] ??= { ok: 0, total: 0 });
        b.total += 1;
        if (row.status === 'ok') b.ok += 1;
      }
    }
  }
  const pick = (k) => ({ ok: buckets[k]?.ok ?? 0, total: buckets[k]?.total ?? 0, rate: buckets[k]?.total ? buckets[k].ok / buckets[k].total : null });
  return {
    today: { all: pick('today.all'), fast: pick('today.fast'), deep: pick('today.deep') },
    week: { all: pick('week.all'), fast: pick('week.fast'), deep: pick('week.deep') }
  };
}

/**
 * 2) 待确认 ratio, per stop: among stops of routebooks created in the last 7 days whose enrichment FINISHED (job done),
 * a stop counts as 待确认 when any of its looked-up fields did not end up filled. Stops that were never looked up
 * (restaurants, no wanted field) are not in the denominator.
 */
export async function pendingRatio(now = Date.now(), store = enrichStore()) {
  const jobs = (await store.listJobs({ since: now - 7 * DAY })).filter((j) => j.status === 'done');
  let stops = 0;
  let pending = 0;
  for (const job of jobs) {
    const result = await store.getResult(job.routebookId);
    const routebook = await getSavedRoutebook(job.routebookId).catch(() => null);
    if (!result || !routebook) continue;
    const keys = new Set((routebook.stops ?? []).map((s, i) => stopKeyOf(s, i)));
    const byStop = new Map();
    for (const c of result.claims ?? []) {
      if (!keys.has(c.stopKey)) continue;
      const entry = byStop.get(c.stopKey) ?? { any: false, unfilled: false };
      entry.any = true;
      if (c.status !== 'filled') entry.unfilled = true;
      byStop.set(c.stopKey, entry);
    }
    for (const entry of byStop.values()) {
      stops += 1;
      if (entry.unfilled) pending += 1;
    }
  }
  return { routebooks: jobs.length, stops, pending, ratio: stops ? pending / stops : null };
}

/** 3) Today's cost vs limit: generation (incl. admin test-runs, shown separately) + enrichment. Unknown costs counted, not guessed. */
export function generationCostToday(rows, now = Date.now()) {
  const today = startOfTodayMs(now);
  const out = { generationUsd: 0, testRunUsd: 0, unknownCostCount: 0, byModel: {} };
  for (const row of rows) {
    if (!['generate-routebook', 'patch-routebook', 'admin-test-run'].includes(row.kind)) continue;
    if (!(Date.parse(row.createdAt ?? '') >= today)) continue;
    const cost = rowCost(row);
    if (cost == null) {
      if (row.status === 'ok' || row.kind === 'admin-test-run') out.unknownCostCount += 1;
      continue;
    }
    if (row.kind === 'admin-test-run') out.testRunUsd += cost;
    else out.generationUsd += cost;
    const model = rowModel(row) || 'unknown';
    out.byModel[model] = (out.byModel[model] ?? 0) + cost;
  }
  return out;
}

export async function dashboard(now = Date.now()) {
  const rows = await readMatchingJsonLines(AI_LOG_PATH, (row) => Date.parse(row?.createdAt ?? '') >= now - 7 * DAY, 200000, 200000);
  const gen = generationCostToday(rows, now);
  const enrichSpend = await enrichStore()
    .getSpend(now)
    .catch(() => ({ usd: 0 }));
  const limit = getConfig('cost.dailyLimitUsd');
  const total = gen.generationUsd + gen.testRunUsd + Number(enrichSpend.usd || 0);
  return {
    generatedAt: new Date(now).toISOString(),
    successRate: successRate(rows, now),
    pendingRatio: await pendingRatio(now),
    cost: {
      ...gen,
      enrichUsd: Number(enrichSpend.usd || 0),
      enrichDay: enrichSpend.day ?? null,
      enrichBudgetUsd: getConfig('enrich.dailyBudgetUsd'),
      totalUsd: total,
      dailyLimitUsd: limit || null,
      ratio: limit ? total / limit : null
    }
  };
}

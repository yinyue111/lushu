// Fact-enrichment storage. PostgreSQL uses dedicated tables (migration 0010); JSONL keeps an append-only
// enrichment.jsonl replayed into memory (the JSONL runtime is single-writer, like accounts.jsonl).
import { appendFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR } from '../config/index.mjs';
import { usesPostgresStorage, getPostgresStorage } from '../storage/runtime.mjs';

const S = 'trusted_routebook';
const iso = (value) => (value instanceof Date ? value.toISOString() : value ? String(value) : null);
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * @typedef {{ routebookId: string, userId: string, status: 'queued'|'running'|'done'|'failed'|'skipped', attempts: number,
 *   nextAttemptAt: string, leaseUntil: string|null, lastError: string, summary: any, createdAt: string, updatedAt: string }} EnrichJob
 */

function createJsonlStore(path = join(DATA_DIR, 'enrichment.jsonl')) {
  const jobs = new Map();
  const results = new Map();
  const cache = new Map();
  const spend = new Map();
  const reports = [];
  let loaded = null;
  const apply = (row) => {
    if (row.t === 'job') jobs.set(row.v.routebookId, row.v);
    else if (row.t === 'result') results.set(row.v.routebookId, row.v);
    else if (row.t === 'cache') row.v.deleted ? cache.delete(row.v.key) : cache.set(row.v.key, row.v);
    else if (row.t === 'spend') spend.set(row.v.day, row.v);
    else if (row.t === 'report') reports.push(row.v);
  };
  const load = () =>
    (loaded ??= (async () => {
      let text = '';
      try {
        text = await readFile(path, 'utf8');
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          apply(JSON.parse(line));
        } catch {
          // torn last line after a crash: skipped
        }
      }
    })());
  const write = async (t, v) => {
    await mkdir(DATA_DIR, { recursive: true });
    await appendFile(path, `${JSON.stringify({ t, v })}\n`, { mode: 0o600 });
    apply({ t, v });
    return v;
  };
  return {
    kind: 'jsonl',
    async enqueue({ routebookId, userId }, now = Date.now()) {
      await load();
      if (jobs.has(routebookId)) return { job: jobs.get(routebookId), created: false };
      const at = new Date(now).toISOString();
      const job = {
        routebookId,
        userId,
        status: 'queued',
        attempts: 0,
        nextAttemptAt: at,
        leaseUntil: null,
        lastError: '',
        summary: {},
        createdAt: at,
        updatedAt: at
      };
      return { job: await write('job', job), created: true };
    },
    async claimDue({ now = Date.now(), leaseMs, limit }) {
      await load();
      const due = [...jobs.values()]
        .filter(
          (j) => (j.status === 'queued' && Date.parse(j.nextAttemptAt) <= now) || (j.status === 'running' && j.leaseUntil && Date.parse(j.leaseUntil) <= now)
        )
        .sort((a, b) => Date.parse(a.nextAttemptAt) - Date.parse(b.nextAttemptAt))
        .slice(0, limit);
      const claimed = [];
      for (const j of due) {
        claimed.push(
          await write('job', {
            ...j,
            status: 'running',
            attempts: j.attempts + 1,
            leaseUntil: new Date(now + leaseMs).toISOString(),
            updatedAt: new Date(now).toISOString()
          })
        );
      }
      return claimed;
    },
    async updateJob(routebookId, patch, now = Date.now()) {
      await load();
      const job = jobs.get(routebookId);
      if (!job) return null;
      return write('job', { ...job, ...patch, updatedAt: new Date(now).toISOString() });
    },
    async getJob(routebookId) {
      await load();
      return jobs.get(routebookId) ?? null;
    },
    async putResult(routebookId, claims, now = Date.now()) {
      await load();
      return write('result', { routebookId, claims, updatedAt: new Date(now).toISOString() });
    },
    async getResult(routebookId) {
      await load();
      return results.get(routebookId) ?? null;
    },
    async getCache(key, now = Date.now()) {
      await load();
      const entry = cache.get(key);
      return entry && Date.parse(entry.expiresAt) > now ? entry.entry : null;
    },
    async putCache(key, entry, expiresAt) {
      await load();
      await write('cache', { key, entry, expiresAt });
    },
    async deleteCache(key) {
      await load();
      if (cache.has(key)) await write('cache', { key, deleted: true });
    },
    async addSpend(delta, now = Date.now()) {
      await load();
      const day = dayOf(now);
      const prev = spend.get(day) ?? { day, usd: 0, searches: 0, pages: 0, amapCalls: 0 };
      return write('spend', {
        day,
        usd: prev.usd + (delta.usd ?? 0),
        searches: prev.searches + (delta.searches ?? 0),
        pages: prev.pages + (delta.pages ?? 0),
        amapCalls: prev.amapCalls + (delta.amapCalls ?? 0)
      });
    },
    async getSpend(now = Date.now()) {
      await load();
      return spend.get(dayOf(now)) ?? { day: dayOf(now), usd: 0, searches: 0, pages: 0, amapCalls: 0 };
    },
    async addReport(report) {
      await load();
      return write('report', report);
    },
    async stats({ days = 7, now = Date.now() } = {}) {
      await load();
      const byStatus = {};
      let filled = 0;
      let kept = 0;
      for (const j of jobs.values()) {
        byStatus[j.status] = (byStatus[j.status] ?? 0) + 1;
        filled += j.summary?.filled ?? 0;
        kept += j.summary?.kept ?? 0;
      }
      const since = dayOf(now - (days - 1) * 86400000);
      return {
        byStatus,
        filled,
        kept,
        spend: [...spend.values()].filter((s) => s.day >= since).sort((a, b) => b.day.localeCompare(a.day)),
        reports: reports.length,
        recentReports: reports.slice(-20).reverse(),
        cacheEntries: [...cache.values()].filter((c) => Date.parse(c.expiresAt) > now).length
      };
    }
  };
}

function createPostgresStore(poolProvider) {
  const q = (text, values) => poolProvider().query(text, values);
  const jobFromRow = (r) =>
    r && {
      routebookId: r.routebook_id,
      userId: r.user_id,
      status: r.status,
      attempts: r.attempts,
      nextAttemptAt: iso(r.next_attempt_at),
      leaseUntil: iso(r.lease_until),
      lastError: r.last_error,
      summary: r.summary ?? {},
      createdAt: iso(r.created_at),
      updatedAt: iso(r.updated_at)
    };
  return {
    kind: 'postgres',
    async enqueue({ routebookId, userId }) {
      const { rows } = await q(`insert into ${S}.enrich_jobs (routebook_id, user_id) values ($1, $2) on conflict (routebook_id) do nothing returning *`, [
        routebookId,
        userId
      ]);
      if (rows[0]) return { job: jobFromRow(rows[0]), created: true };
      return { job: await this.getJob(routebookId), created: false };
    },
    async claimDue({ now = Date.now(), leaseMs, limit }) {
      // skip locked: several app instances can share the queue safely.
      const { rows } = await q(
        `update ${S}.enrich_jobs j set status = 'running', attempts = j.attempts + 1, lease_until = $1::timestamptz + ($2 || ' milliseconds')::interval, updated_at = clock_timestamp()
         where j.routebook_id in (
           select routebook_id from ${S}.enrich_jobs
           where (status = 'queued' and next_attempt_at <= $1) or (status = 'running' and lease_until <= $1)
           order by next_attempt_at limit $3 for update skip locked)
         returning j.*`,
        [new Date(now).toISOString(), String(leaseMs), limit]
      );
      return rows.map(jobFromRow);
    },
    async updateJob(routebookId, patch) {
      const cols = {
        status: 'status',
        nextAttemptAt: 'next_attempt_at',
        leaseUntil: 'lease_until',
        lastError: 'last_error',
        summary: 'summary',
        attempts: 'attempts'
      };
      const sets = [];
      const values = [routebookId];
      for (const [key, column] of Object.entries(cols)) {
        if (!(key in patch)) continue;
        values.push(key === 'summary' ? JSON.stringify(patch[key]) : patch[key]);
        sets.push(`${column} = $${values.length}${key === 'summary' ? '::jsonb' : ''}`);
      }
      const { rows } = await q(`update ${S}.enrich_jobs set ${sets.join(', ')}, updated_at = clock_timestamp() where routebook_id = $1 returning *`, values);
      return jobFromRow(rows[0]) ?? null;
    },
    async getJob(routebookId) {
      return jobFromRow((await q(`select * from ${S}.enrich_jobs where routebook_id = $1`, [routebookId])).rows[0]) ?? null;
    },
    async putResult(routebookId, claims) {
      await q(
        `insert into ${S}.enrich_results (routebook_id, claims) values ($1, $2::jsonb)
         on conflict (routebook_id) do update set claims = excluded.claims, updated_at = clock_timestamp()`,
        [routebookId, JSON.stringify(claims)]
      );
      return { routebookId, claims };
    },
    async getResult(routebookId) {
      const r = (await q(`select * from ${S}.enrich_results where routebook_id = $1`, [routebookId])).rows[0];
      return r ? { routebookId, claims: r.claims, updatedAt: iso(r.updated_at) } : null;
    },
    async getCache(key, now = Date.now()) {
      const r = (await q(`select entry from ${S}.enrich_cache where key = $1 and expires_at > $2`, [key, new Date(now).toISOString()])).rows[0];
      return r?.entry ?? null;
    },
    async putCache(key, entry, expiresAt) {
      await q(
        `insert into ${S}.enrich_cache (key, entry, expires_at) values ($1, $2::jsonb, $3)
         on conflict (key) do update set entry = excluded.entry, expires_at = excluded.expires_at`,
        [key, JSON.stringify(entry), expiresAt]
      );
      await q(`delete from ${S}.enrich_cache where expires_at < clock_timestamp() - interval '1 day'`);
    },
    async deleteCache(key) {
      await q(`delete from ${S}.enrich_cache where key = $1`, [key]);
    },
    async addSpend(delta, now = Date.now()) {
      await q(
        `insert into ${S}.enrich_spend (day, usd, searches, pages, amap_calls) values ($1, $2, $3, $4, $5)
         on conflict (day) do update set usd = ${S}.enrich_spend.usd + excluded.usd, searches = ${S}.enrich_spend.searches + excluded.searches,
           pages = ${S}.enrich_spend.pages + excluded.pages, amap_calls = ${S}.enrich_spend.amap_calls + excluded.amap_calls`,
        [dayOf(now), delta.usd ?? 0, delta.searches ?? 0, delta.pages ?? 0, delta.amapCalls ?? 0]
      );
    },
    async getSpend(now = Date.now()) {
      const r = (await q(`select * from ${S}.enrich_spend where day = $1`, [dayOf(now)])).rows[0];
      return r
        ? { day: dayOf(now), usd: Number(r.usd), searches: r.searches, pages: r.pages, amapCalls: r.amap_calls }
        : { day: dayOf(now), usd: 0, searches: 0, pages: 0, amapCalls: 0 };
    },
    async addReport(report) {
      await q(`insert into ${S}.enrich_reports (id, routebook_id, stop_key, field, cache_key, note, user_id, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8)`, [
        report.id,
        report.routebookId,
        report.stopKey,
        report.field,
        report.cacheKey ?? '',
        report.note ?? '',
        report.userId ?? null,
        report.createdAt
      ]);
      return report;
    },
    async stats({ days = 7, now = Date.now() } = {}) {
      const status = await q(
        `select status, count(*)::int as n, coalesce(sum((summary->>'filled')::int), 0)::int as filled, coalesce(sum((summary->>'kept')::int), 0)::int as kept
         from ${S}.enrich_jobs group by status`
      );
      const byStatus = {};
      let filled = 0;
      let kept = 0;
      for (const r of status.rows) {
        byStatus[r.status] = r.n;
        filled += r.filled;
        kept += r.kept;
      }
      const since = dayOf(now - (days - 1) * 86400000);
      const spendRows = await q(`select *, day::text as d from ${S}.enrich_spend where day >= $1 order by day desc`, [since]);
      const reportCount = await q(`select count(*)::int as n from ${S}.enrich_reports`);
      const recent = await q(`select * from ${S}.enrich_reports order by created_at desc limit 20`);
      const cacheCount = await q(`select count(*)::int as n from ${S}.enrich_cache where expires_at > $1`, [new Date(now).toISOString()]);
      return {
        byStatus,
        filled,
        kept,
        spend: spendRows.rows.map((r) => ({
          day: r.d,
          usd: Number(r.usd),
          searches: r.searches,
          pages: r.pages,
          amapCalls: r.amap_calls
        })),
        reports: reportCount.rows[0].n,
        recentReports: recent.rows.map((r) => ({
          id: r.id,
          routebookId: r.routebook_id,
          stopKey: r.stop_key,
          field: r.field,
          cacheKey: r.cache_key,
          note: r.note,
          createdAt: iso(r.created_at)
        })),
        cacheEntries: cacheCount.rows[0].n
      };
    }
  };
}

let store = null;
export function enrichStore() {
  store ??= usesPostgresStorage() ? createPostgresStore(() => getPostgresStorage().pool) : createJsonlStore();
  return store;
}
export function setEnrichStoreForTests(next) {
  store = next;
}
export { createJsonlStore, createPostgresStore };

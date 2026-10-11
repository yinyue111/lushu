// Shared contract for the enrichment store (JSONL and PostgreSQL).
import assert from 'node:assert/strict';

export async function runEnrichStoreContract(store) {
  const t0 = Date.parse('2026-10-11T00:00:00Z');
  const first = await store.enqueue({ routebookId: 'rb-1', userId: 'u-1' }, t0);
  assert.equal(first.created, true);
  assert.equal(first.job.status, 'queued');
  assert.equal((await store.enqueue({ routebookId: 'rb-1', userId: 'u-1' }, t0)).created, false, 'one job per routebook');
  await store.enqueue({ routebookId: 'rb-2', userId: 'u-1' }, t0);

  const claimed = await store.claimDue({ now: Date.now(), leaseMs: 60000, limit: 1 });
  assert.equal(claimed.length, 1, 'bounded by limit');
  assert.equal(claimed[0].status, 'running');
  assert.equal(claimed[0].attempts, 1);
  const second = await store.claimDue({ now: Date.now(), leaseMs: 60000, limit: 5 });
  assert.equal(second.length, 1, 'a running job with a live lease is not claimed twice');
  // Crash: the lease runs out, the job is picked up again (restart-safe).
  const afterLease = await store.claimDue({ now: Date.now() + 120000, leaseMs: 60000, limit: 5 });
  assert.equal(afterLease.length, 2);
  assert.equal(afterLease.find((j) => j.routebookId === claimed[0].routebookId).attempts, 2);

  const retryAt = new Date(Date.now() + 3600000).toISOString();
  await store.updateJob('rb-1', { status: 'queued', leaseUntil: null, lastError: 'boom', nextAttemptAt: retryAt });
  assert.equal(
    (await store.claimDue({ now: Date.now() + 120000 * 10, leaseMs: 60000, limit: 5 })).filter((j) => j.routebookId === 'rb-1').length,
    0,
    'backoff respected'
  );
  await store.updateJob('rb-2', { status: 'done', leaseUntil: null, summary: { filled: 2, kept: 3 } });
  assert.equal((await store.getJob('rb-2')).status, 'done');
  assert.deepEqual((await store.getJob('rb-2')).summary, { filled: 2, kept: 3 });

  await store.putResult('rb-2', [{ stopKey: 's1', field: 'price', status: 'filled', value: '免费' }]);
  await store.putResult('rb-2', [{ stopKey: 's1', field: 'price', status: 'disputed', value: '免费' }]);
  assert.equal((await store.getResult('rb-2')).claims[0].status, 'disputed');

  await store.putCache('杭州|灵隐寺|price', { status: 'filled', value: '免费' }, new Date(Date.now() + 86400000).toISOString());
  assert.equal((await store.getCache('杭州|灵隐寺|price')).value, '免费');
  assert.equal(await store.getCache('杭州|灵隐寺|price', Date.now() + 2 * 86400000), null, 'expired');
  await store.deleteCache('杭州|灵隐寺|price');
  assert.equal(await store.getCache('杭州|灵隐寺|price'), null);

  await store.addSpend({ usd: 0.05, searches: 1 });
  await store.addSpend({ usd: 0.1, searches: 1, pages: 3, amapCalls: 2 });
  const spend = await store.getSpend();
  assert.ok(Math.abs(spend.usd - 0.15) < 1e-9);
  assert.equal(spend.searches, 2);
  assert.equal(spend.pages, 3);

  await store.addReport({
    id: 'rep-1',
    routebookId: 'rb-2',
    stopKey: 's1',
    field: 'price',
    cacheKey: '',
    note: '其实收费',
    userId: null,
    createdAt: new Date().toISOString()
  });
  const stats = await store.stats();
  assert.equal(stats.byStatus.done, 1);
  assert.equal(stats.filled, 2);
  assert.equal(stats.reports, 1);
  assert.equal(stats.spend[0].searches, 2);
  assert.match(stats.spend[0].day, /^\d{4}-\d{2}-\d{2}$/);
}

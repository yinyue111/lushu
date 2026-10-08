import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNonceStore } from '../../server/auth/nonce-store.mjs';

test('nonce can be consumed only once', async () => {
  const store = createNonceStore();
  assert.equal(await store.consume('a', Date.now() + 60000), true);
  assert.equal(await store.consume('a', Date.now() + 60000), false);
  assert.equal(await store.consume('b', Date.now() + 60000), true);
});

test('concurrent consumption of the same nonce lets exactly one win', async () => {
  const store = createNonceStore();
  const results = await Promise.all(Array.from({ length: 10 }, () => store.consume('same', Date.now() + 60000)));
  assert.equal(results.filter(Boolean).length, 1);
});

test('persisted nonces survive a restart; expired ones are pruned', async () => {
  let clock = 1_000_000;
  const persisted = [];
  const first = createNonceStore({ now: () => clock, persist: async (record) => { persisted.push(record); } });
  await first.consume('kept', clock + 10_000);
  await first.consume('short', clock + 10);
  assert.equal(persisted.length, 2);

  clock += 100;
  const restarted = createNonceStore({ now: () => clock, load: async () => persisted });
  assert.equal(await restarted.consume('kept', clock + 10_000), false, 'replay after restart is rejected');
  assert.equal(await restarted.consume('short', clock + 10_000), true, 'expired entries are forgotten');
  clock += 20_000;
  assert.equal(await restarted.consume('another', clock + 1), true);
  assert.equal(restarted.size(), 1, 'expired entries pruned from memory');
});

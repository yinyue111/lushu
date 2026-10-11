import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pullAccountRoutebooks } from '../../src/lib/accountRoutebookPull.js';

const profile = { id: 'p_account', accountUserId: 'u_1' };

function book(id, { updatedAt = '2026-10-11T00:00:00.000Z', stops = 2, city = '杭州' } = {}) {
  return {
    publicId: id,
    id,
    city,
    title: `路书 ${id}`,
    profileId: 'p_account',
    publishStatus: 'draft',
    updatedAt,
    stops: Array.from({ length: stops }, (_, i) => ({ name: `站${i + 1}`, day: '第1天' }))
  };
}

test('pullAccountRoutebooks writes cloud drafts into local storage for a signed-in account', async () => {
  /** @type {Record<string, any>[]} */
  const local = [];
  const result = await pullAccountRoutebooks({
    profile,
    list: async () => ({ routebooks: [book('rb_a'), book('rb_b')] }),
    getLocal: () => local,
    persist: (row) => {
      local.push(row);
      return true;
    }
  });
  assert.equal(result.total, 2);
  assert.deepEqual(result.pulled.sort(), ['rb_a', 'rb_b']);
  assert.equal(local.length, 2);
  assert.equal(local[0].profileId, 'p_account');
});

test('newer local edits are kept; incomplete remote rows are skipped', async () => {
  const local = [book('rb_a', { updatedAt: '2026-10-12T00:00:00.000Z', stops: 3 })];
  const persisted = [];
  const result = await pullAccountRoutebooks({
    profile,
    list: async () => ({
      routebooks: [book('rb_a', { updatedAt: '2026-10-10T00:00:00.000Z' }), { publicId: 'rb_empty', city: '杭州', stops: [] }, book('rb_c')]
    }),
    getLocal: () => local,
    persist: (row) => {
      persisted.push(row.publicId);
      return true;
    }
  });
  assert.deepEqual(result.pulled, ['rb_c']);
  assert.ok(result.skipped.includes('rb_a'));
  assert.ok(result.skipped.includes('rb_empty'));
  assert.deepEqual(persisted, ['rb_c']);
});

test('guests without account or profile token do not pull', async () => {
  const result = await pullAccountRoutebooks({
    profile: { id: 'p_guest' },
    list: async () => {
      throw new Error('should not list');
    },
    getLocal: () => [],
    persist: () => true
  });
  assert.equal(result.reason, 'not-signed-in');
  assert.equal(result.total, 0);
});

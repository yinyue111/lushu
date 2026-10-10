import assert from 'node:assert/strict';
import { test } from 'node:test';

const values = new Map();
globalThis.localStorage = {
  get length() {
    return values.size;
  },
  clear: () => values.clear(),
  key: (index) => [...values.keys()][index] ?? null,
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => void values.set(key, value),
  removeItem: (key) => void values.delete(key)
};
const { saveRoutebook, getStoredRoutebookById } = await import('../../src/lib/storage.js');
const { cloudIdsOf, dropDeletedLocalCopy, pruneDeletedLocalRoutebooks } = await import('../../src/lib/routebookTombstones.js');

const book = (id, extra = {}) => ({ id, publicId: id, city: '杭州', title: id, profileId: 'p1', stops: [{ name: 'A' }, { name: 'B' }], version: 2, ...extra });

test('only copies that reached the cloud are checked', () => {
  assert.deepEqual(cloudIdsOf([book('a'), book('b', { publicId: '', version: 0 }), book('a')]), ['a']);
});

test('deleted ids reported by the server are dropped from this device; others stay', async () => {
  saveRoutebook(book('keep-1'));
  saveRoutebook(book('gone-1'));
  assert.ok(getStoredRoutebookById('gone-1'));
  let asked = [];
  const removed = await pruneDeletedLocalRoutebooks([book('keep-1'), book('gone-1')], async (ids) => {
    asked = ids;
    return { deleted: ['gone-1'] };
  });
  assert.deepEqual(asked, ['keep-1', 'gone-1']);
  assert.deepEqual(removed, ['gone-1']);
  assert.equal(getStoredRoutebookById('gone-1'), null);
  assert.ok(getStoredRoutebookById('keep-1'));
  assert.equal(dropDeletedLocalCopy('gone-1'), false, 'idempotent');
});

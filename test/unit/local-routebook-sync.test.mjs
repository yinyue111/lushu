import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isLocalOnlyRoutebook, uploadLocalOnlyRoutebooks } from '../../src/lib/localRoutebookSync.js';

const stops = [
  { id: 'a', name: 'A' },
  { id: 'b', name: 'B' }
];
const book = (id, extra = {}) => ({
  id,
  publicId: id,
  city: '杭州',
  stops,
  version: 0,
  publishStatus: 'draft',
  editToken: `tok-${id}`,
  updatedAt: '2026-10-09T10:00:00.000Z',
  ...extra
});
const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

function harness(saveImpl, remotes = {}) {
  const persisted = [];
  const conflicts = [];
  const saves = [];
  return {
    persisted,
    conflicts,
    saves,
    deps: {
      profile: { id: 'p1', profileAccessToken: 'secret' },
      profileFields: (profile) => ({ profileId: profile.id }),
      save: async (input) => {
        saves.push(input);
        return saveImpl(input);
      },
      fetchRemote: async (id) => {
        if (!remotes[id]) throw httpError(404);
        return { routebook: remotes[id] };
      },
      persist: (value) => persisted.push(value) > 0,
      preserveConflict: (value, label) => {
        conflicts.push({ id: value.id, label });
        return { saved: true, draft: { ...value, id: `${value.id}-conflict` } };
      }
    }
  };
}

test('only never-uploaded drafts count as local-only', () => {
  assert.equal(isLocalOnlyRoutebook(book('x')), true);
  assert.equal(isLocalOnlyRoutebook(book('x', { version: 3 })), false);
  assert.equal(isLocalOnlyRoutebook(book('x', { publishStatus: 'published' })), false);
  assert.equal(isLocalOnlyRoutebook(book('x', { cloudSyncBlocked: true })), false);
});

test('nothing is uploaded until cloud sync is enabled', async () => {
  const h = harness(async () => ({ routebook: {} }));
  const result = await uploadLocalOnlyRoutebooks({ ...h.deps, profile: { id: 'p1' }, books: [book('a')] });
  assert.equal(result.skipped, 'cloud-sync-disabled');
  assert.equal(h.saves.length, 0);
});

test('local-only copies upload with expectedVersion 0 and adopt the cloud version', async () => {
  const h = harness(async (input) => ({ routebook: { ...input, version: 1, editToken: '' } }));
  const result = await uploadLocalOnlyRoutebooks({ ...h.deps, books: [book('a'), book('b', { version: 2 })] });
  assert.deepEqual(result.uploaded, ['a']);
  assert.equal(h.saves[0].expectedVersion, 0);
  assert.equal(h.saves[0].profileId, 'p1');
  assert.equal(h.persisted[0].version, 1);
  assert.equal(h.persisted[0].editToken, 'tok-a', 'keeps the local edit token when the server hides it');
});

test('conflicts: newer cloud copy wins and local edits become a 冲突副本; older cloud copy is overwritten', async () => {
  const remotes = {
    newer: { ...book('newer'), version: 2, updatedAt: '2026-10-09T12:00:00.000Z', title: 'cloud' },
    older: { ...book('older'), version: 1, updatedAt: '2026-10-09T08:00:00.000Z' }
  };
  const h = harness(async (input) => {
    if (input.expectedVersion === 0) throw httpError(409);
    return { routebook: { ...input, version: input.expectedVersion + 1 } };
  }, remotes);
  const result = await uploadLocalOnlyRoutebooks({ ...h.deps, books: [book('newer'), book('older')] });
  assert.deepEqual(result.conflicts, ['newer']);
  assert.deepEqual(result.uploaded, ['older']);
  assert.deepEqual(h.conflicts, [{ id: 'newer', label: '云端同步冲突' }]);
  assert.equal(h.persisted.find((item) => item.id === 'newer').title, 'cloud');
  assert.equal(h.persisted.find((item) => item.id === 'older').version, 2);
});

test('network failures are retried later; foreign ids are blocked and copied', async () => {
  const h = harness(async (input) => {
    throw input.id === 'offline' ? new TypeError('Failed to fetch') : httpError(403);
  });
  const result = await uploadLocalOnlyRoutebooks({ ...h.deps, books: [book('offline'), book('foreign')] });
  assert.deepEqual(result.failed, ['offline']);
  assert.deepEqual(result.conflicts, ['foreign']);
  assert.equal(h.persisted.find((item) => item.id === 'foreign').cloudSyncBlocked, true);
});

test('a deleted routebook (410) is never re-uploaded and never kept as a conflict copy', async () => {
  const deleted = Object.assign(new Error('gone'), { status: 410, code: 'ROUTEBOOK_DELETED' });
  const h = harness(async () => {
    throw deleted;
  });
  const result = await uploadLocalOnlyRoutebooks({ ...h.deps, books: [book('gone')] });
  assert.deepEqual(result.deleted, ['gone']);
  assert.deepEqual(result.conflicts, []);
  assert.equal(h.conflicts.length, 0);
  assert.equal(h.persisted.length, 0);
});

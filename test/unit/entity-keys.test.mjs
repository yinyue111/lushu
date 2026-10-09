import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  STREAM_ENTITY_KEYS,
  encodeEntityKey,
  entityKeyFunctionForStream,
  profileEntityKey,
  publicIdEntityKey,
  storedEntityKey
} from '../../server/storage/entityKeys.mjs';
import { findLatestByEntityKey, findLatestBySecondaryKey } from '../../server/storage/keyedLookup.mjs';

const line = (row) => `${JSON.stringify(row)}\n`;

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'entity-keys-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('entity key functions mirror the historical lookup predicates', () => {
  assert.equal(publicIdEntityKey({ id: 'rb-1' }), 'rb-1');
  assert.equal(publicIdEntityKey({ publicId: 'rb 2/x' }), 'rb2x', 'ids are sanitised like sanitizePublicId');
  assert.equal(profileEntityKey({ profileId: 'p_1' }), 'p_1');
  assert.equal(profileEntityKey({ id: 'anonymous' }), '', 'anonymous profiles are never keyed');
  assert.equal(entityKeyFunctionForStream('identity-nonces')({ key: 42 }), '', 'non-string nonce keys never match');
  assert.equal(entityKeyFunctionForStream('exposures')({ id: 'e-1' }), 'e-1');
  assert.equal(entityKeyFunctionForStream('ai-logs'), null);
  assert.equal(storedEntityKey('ai-logs', { id: 'x' }), '', 'unkeyed streams store an empty (computed) key');
  assert.ok(Object.isFrozen(STREAM_ENTITY_KEYS));
});

test('over-long keys are encoded deterministically to a bounded hash', () => {
  const longKey = 'k'.repeat(500);
  assert.equal(encodeEntityKey('short'), 'short');
  assert.equal(encodeEntityKey(longKey), encodeEntityKey(longKey));
  assert.match(encodeEntityKey(longKey), /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(encodeEntityKey(longKey), encodeEntityKey(`${longKey}x`));
});

test('JSONL keyed lookups return the latest row per key and see later appends', async () => {
  await withDir(async (dir) => {
    const sessions = join(dir, 'trip-sessions.jsonl');
    await writeFile(
      sessions,
      [line({ sessionKey: 's-a', revision: 1 }), line({ sessionKey: 's-b', revision: 1 }), line({ sessionKey: 's-a', revision: 2 })].join('')
    );
    assert.equal((await findLatestByEntityKey(sessions, 's-a')).revision, 2);
    await appendFile(sessions, line({ sessionKey: 's-a', revision: 3 }));
    assert.equal((await findLatestByEntityKey(sessions, 's-a')).revision, 3);
    assert.equal(await findLatestByEntityKey(sessions, 'missing'), null);
    assert.equal(await findLatestByEntityKey(sessions, ''), null);

    // Non-indexed streams (high-cardinality logs) keep the exact reverse scan.
    const checkins = join(dir, 'checkins.jsonl');
    await writeFile(checkins, [line({ id: 'c-1', v: 1 }), line({ id: 'c-2', v: 1 }), line({ id: 'c-1', v: 2 })].join(''));
    assert.equal((await findLatestByEntityKey(checkins, 'c-1')).v, 2);
  });
});

test('registration hash lookups use a secondary index with latest-row semantics', async () => {
  await withDir(async (dir) => {
    const profiles = join(dir, 'profiles.jsonl');
    await writeFile(
      profiles,
      [
        line({ id: 'p_a', registrationCredentialHash: 'h1', revision: 1 }),
        line({ id: 'p_b', registrationCredentialHash: 'h2' }),
        line({ id: 'p_a', registrationCredentialHash: 'h1', revision: 2 }),
        line({ id: 'p_c' })
      ].join('')
    );
    assert.equal((await findLatestBySecondaryKey(profiles, 'registrationCredentialHash', 'h1')).revision, 2);
    assert.equal((await findLatestBySecondaryKey(profiles, 'registrationCredentialHash', 'h2')).id, 'p_b');
    assert.equal(await findLatestBySecondaryKey(profiles, 'registrationCredentialHash', 'nope'), null);
    await assert.rejects(() => findLatestBySecondaryKey(profiles, 'id', 'p_a'), /no secondary key/);
  });
});

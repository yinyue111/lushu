import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJsonlStore } from '../../server/accounts/store.mjs';
import { runAccountStoreContract } from '../support/account-store-contract.mjs';

test('JSONL account store honours the shared contract and replays from disk', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'accounts-')), 'accounts.jsonl');
  await runAccountStoreContract(createJsonlStore(path));
  const replay = createJsonlStore(path);
  assert.equal((await replay.findUserByPhoneHash('h1')).id, 'u_d');
  assert.equal(await replay.findUserIdByProfile('p_old'), 'u_d');
  assert.ok(!(await readFile(path, 'utf8')).includes('13812345678'));
});

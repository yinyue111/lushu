import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJsonlStore } from '../../server/admin/store.mjs';
import { runAdminStoreContract } from '../support/admin-store-contract.mjs';

test('admin JSONL store satisfies the shared admin-store contract', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'admin-store-contract-'));
  await runAdminStoreContract(createJsonlStore(join(dir, 'admin.jsonl')), { label: 'jsonl' });
});

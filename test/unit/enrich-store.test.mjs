import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createJsonlStore } from '../../server/enrich/store.mjs';
import { runEnrichStoreContract } from '../support/enrich-store-contract.mjs';

test('enrichment store contract (JSONL), including replay after restart', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'enrich-store-')), 'enrichment.jsonl');
  await runEnrichStoreContract(createJsonlStore(path));
  const reopened = createJsonlStore(path);
  const job = await reopened.getJob('rb-2');
  if (job?.status !== 'done') throw new Error('jobs must survive a restart');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJsonlKeyIndex } from '../../server/storage/jsonl-index.mjs';

test('a JSONL privacy rewrite during initial indexing neither throws nor resurrects deleted rows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lushu-index-rewrite-race-'));
  try {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const filePath = join(directory, `rows-${attempt}.jsonl`);
      const replacement = join(directory, `replacement-${attempt}.jsonl`);
      const rows = Array.from({ length: 12000 }, (_, index) => JSON.stringify({ id: `row-${index}`, text: '隐私历史'.repeat(30) })).join('\n') + '\n';
      await writeFile(filePath, rows);
      await writeFile(replacement, `${JSON.stringify({ id: 'row-11999', tombstone: true })}\n`);
      const index = createJsonlKeyIndex({ filePath, keyFn: (row) => row.id });
      const firstRead = index.get('row-11999');
      await new Promise((resolve) => setImmediate(resolve));
      await rename(replacement, filePath);
      const reads = await Promise.allSettled([firstRead, index.get('row-11999'), index.get('row-1')]);
      assert.equal(
        reads.some((read) => read.status === 'rejected'),
        false,
        reads
          .filter((read) => read.status === 'rejected')
          .map((read) => read.reason?.stack || String(read.reason))
          .join('\n')
      );
      assert.equal((await index.get('row-11999')).tombstone, true);
      assert.equal(await index.get('row-1'), null);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

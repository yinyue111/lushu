import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readJsonLines, readMatchingJsonLines } from '../../server/storage/jsonl.mjs';

// Callers (ops audit context, POI catalog, dashboard) pass Infinity to mean
// "read the whole stream"; the PG adapter already did, JSONL silently capped at 50.
test('JSONL Infinity limit reads every row like the PostgreSQL adapter', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-all-'));
  const file = join(dir, 'rows.jsonl');
  await writeFile(file, `${Array.from({ length: 120 }, (_, index) => JSON.stringify({ index })).join('\n')}\n`);
  assert.equal((await readJsonLines(file, Number.POSITIVE_INFINITY)).length, 120);
  assert.equal((await readMatchingJsonLines(file, () => true, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)).length, 120);
  assert.equal((await readJsonLines(file)).length, 50);
  assert.equal((await readJsonLines(file, 7)).length, 7);
  assert.equal((await readJsonLines(file, 0)).length, 1);
});

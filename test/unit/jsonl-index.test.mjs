import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJsonlKeyIndex } from '../../server/storage/jsonl-index.mjs';

async function withFile(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-index-'));
  try {
    await fn(join(dir, 'rows.jsonl'), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const line = (row) => `${JSON.stringify(row)}\n`;
const keyFn = (row) => (typeof row?.id === 'string' ? row.id : '');

test('missing file returns null and recovers once the file appears', async () => {
  await withFile(async (filePath) => {
    const index = createJsonlKeyIndex({ filePath, keyFn });
    assert.equal(await index.get('a'), null);
    await writeFile(filePath, line({ id: 'a', v: 1 }));
    assert.deepEqual(await index.get('a'), { id: 'a', v: 1 });
  });
});

test('latest row per key wins, corrupted rows and blank lines are skipped', async () => {
  await withFile(async (filePath) => {
    await writeFile(filePath, [line({ id: 'a', v: 1 }), '{not json\n', '\n', line({ id: 'b', v: 1 }), line({ id: 'a', v: 2 }), line({ v: 'no-key' })].join(''));
    const index = createJsonlKeyIndex({ filePath, keyFn });
    assert.deepEqual(await index.get('a'), { id: 'a', v: 2 });
    assert.deepEqual(await index.get('b'), { id: 'b', v: 1 });
    assert.equal(await index.get('zzz'), null);
    assert.equal(index.stats().keys, 2);
  });
});

test('appends (including by another writer) are visible on the next lookup', async () => {
  await withFile(async (filePath) => {
    await writeFile(filePath, line({ id: 'a', v: 1 }));
    const index = createJsonlKeyIndex({ filePath, keyFn });
    assert.equal((await index.get('a')).v, 1);
    await appendFile(filePath, line({ id: 'a', v: 2 }) + line({ id: 'c', v: 1 }));
    assert.equal((await index.get('a')).v, 2);
    assert.equal((await index.get('c')).v, 1);
  });
});

test('a partially written trailing row is ignored until it is completed', async () => {
  await withFile(async (filePath) => {
    await writeFile(filePath, line({ id: 'a', v: 1 }) + '{"id":"a","v":');
    const index = createJsonlKeyIndex({ filePath, keyFn });
    assert.equal((await index.get('a')).v, 1);
    await appendFile(filePath, '2}\n');
    assert.equal((await index.get('a')).v, 2);
  });
});

test('byte offsets are correct for multi-byte UTF-8 content across chunk boundaries', async () => {
  await withFile(async (filePath) => {
    const rows = [];
    // > 1 MiB so the build crosses the internal chunk size.
    for (let i = 0; i < 6000; i += 1) rows.push(line({ id: `r${i % 1500}`, i, text: '杭州西湖断桥残雪'.repeat(10) }));
    await writeFile(filePath, rows.join(''));
    const index = createJsonlKeyIndex({ filePath, keyFn });
    for (const id of ['r0', 'r777', 'r1499']) {
      const row = await index.get(id);
      assert.equal(row.id, id);
      assert.equal(row.i, 4500 + Number(id.slice(1)));
      assert.ok(row.text.startsWith('杭州西湖'));
    }
  });
});

test('truncation or replacement of the file triggers a rebuild', async () => {
  await withFile(async (filePath, dir) => {
    await writeFile(filePath, line({ id: 'a', v: 1 }) + line({ id: 'b', v: 1 }));
    const index = createJsonlKeyIndex({ filePath, keyFn });
    assert.equal((await index.get('b')).v, 1);
    await writeFile(filePath, line({ id: 'a', v: 9 }));
    assert.equal((await index.get('a')).v, 9);
    assert.equal(await index.get('b'), null);
    const replacement = join(dir, 'next.jsonl');
    await writeFile(replacement, line({ id: 'b', v: 7 }) + line({ id: 'x', v: 1 }) + line({ id: 'y', v: 1 }));
    await rename(replacement, filePath);
    assert.equal((await index.get('b')).v, 7);
    assert.equal(await index.get('a'), null);
  });
});

test('concurrent lookups after an append all observe the append', async () => {
  await withFile(async (filePath) => {
    await writeFile(filePath, line({ id: 'a', v: 1 }));
    const index = createJsonlKeyIndex({ filePath, keyFn });
    await index.get('a');
    const pending = index.get('a');
    await appendFile(filePath, line({ id: 'a', v: 2 }));
    const results = await Promise.all([pending, index.get('a'), index.get('a')]);
    // The lookup that started before the append may see either version; later ones must see v2.
    assert.ok([1, 2].includes(results[0].v));
    assert.equal(results[1].v, 2);
    assert.equal(results[2].v, 2);
  });
});

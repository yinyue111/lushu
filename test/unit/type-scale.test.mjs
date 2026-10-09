import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TYPE_SCALE, cn } from '../../src/components/ui/cn.js';

const css = readFileSync(new URL('../../src/styles/tailwind.css', import.meta.url), 'utf8');
const tokens = [...css.matchAll(/^\s+--text-([a-z0-9-]+):/gm)].map((match) => match[1]);

test('tailwind-merge knows every --text-* size token (and nothing else)', () => {
  assert.deepEqual([...TYPE_SCALE].sort(), [...tokens].sort());
});

test('named font sizes survive merging with text colours and replace each other', () => {
  assert.equal(cn('text-meta text-muted'), 'text-meta text-muted');
  assert.equal(cn('text-copy font-bold text-ink'), 'text-copy font-bold text-ink');
  assert.equal(cn('text-meta', 'text-copy'), 'text-copy');
  assert.equal(cn('text-primary', 'text-ink'), 'text-ink');
});

test('no arbitrary pixel font sizes remain in the UI source', async () => {
  const { listFiles } = await import('../../scripts/lib/list-files.mjs');
  const root = new URL('../../', import.meta.url).pathname;
  const offenders = listFiles(root, (path) => /^src\/.+\.(jsx|js)$/.test(path)).filter((file) => /text-\[\d+px\]/.test(readFileSync(file, 'utf8')));
  assert.deepEqual(offenders, []);
});

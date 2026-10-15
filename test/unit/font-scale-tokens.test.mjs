import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// V-U28: type tokens are rem so a 200% system font size scales hero and stop names too.
test('text tokens (except decorative watermarks) are rem, not px', () => {
  const css = readFileSync(new URL('../../src/styles/tailwind.css', import.meta.url), 'utf8');
  const tokens = [...css.matchAll(/--text-([a-z-]+):\s*([^;]+);/g)].filter(([, name]) => !name.startsWith('watermark') && !name.includes('--'));
  assert.ok(tokens.length >= 10);
  for (const [, name, value] of tokens) assert.match(value.trim(), /rem$/, `--text-${name}`);
});

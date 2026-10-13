import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCmsConfig } from '../../server/content/cms.mjs';

test('heroSubtitle is kept, trimmed to 140 chars, and defaults to empty (frontend fallback)', () => {
  assert.equal(normalizeCmsConfig({ heroSubtitle: '周末去哪' }).heroSubtitle, '周末去哪');
  assert.equal(normalizeCmsConfig({}).heroSubtitle, '');
  assert.ok(normalizeCmsConfig({ heroSubtitle: 'x'.repeat(300) }).heroSubtitle.length <= 140);
});

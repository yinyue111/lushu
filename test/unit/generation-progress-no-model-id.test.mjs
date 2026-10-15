import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const SOURCE = readFileSync(new URL('../../src/components/Builder/GenerationProgress.jsx', import.meta.url), 'utf8');

test('progress page never interpolates stage.detail into the running model step (no model ID)', () => {
  // Running model step must use fixed user copy, not `${stage.detail} …`.
  assert.match(SOURCE, /AI 正在排路线，这一步最久/);
  assert.doesNotMatch(SOURCE, /stage\.detail\s*\?\s*`\$\{stage\.detail\}/);
  assert.doesNotMatch(SOURCE, /正在编排路线/);
  assert.match(SOURCE, /正在排路线/);
});

test('progress page source does not render provider.model or raw model id fields', () => {
  assert.doesNotMatch(SOURCE, /provider\.model/);
  assert.doesNotMatch(SOURCE, /runtime\.model/);
  assert.doesNotMatch(SOURCE, /job\.model/);
});

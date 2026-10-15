import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelStatusLabel } from '../../src/lib/modelStatus.js';

test('header AI status hides when ready; only surfaces when blocked', () => {
  assert.equal(modelStatusLabel(null).hide, true);
  assert.equal(modelStatusLabel({ ready: true, access: 'open' }).hide, true);
  assert.equal(modelStatusLabel({ ready: false, modelReady: true, access: 'needs-access-code' }).label, '需要访问码');
  assert.equal(modelStatusLabel({ ready: false, modelReady: true, access: 'disabled' }).label, 'AI 暂时不可用，稍后再试');
  assert.equal(modelStatusLabel({ ready: false, modelReady: false, access: 'needs-access-code' }).label, 'AI 暂时不可用，稍后再试');
});

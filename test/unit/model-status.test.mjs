import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelStatusLabel } from '../../src/lib/modelStatus.js';

test('header AI status reflects real access, not just model configuration', () => {
  assert.equal(modelStatusLabel(null).label, '正在检查 AI');
  assert.equal(modelStatusLabel({ ready: true, access: 'open' }).label, 'AI 已就绪');
  assert.equal(modelStatusLabel({ ready: false, modelReady: true, access: 'needs-access-code' }).label, '需要访问码');
  assert.equal(modelStatusLabel({ ready: false, modelReady: true, access: 'disabled' }).label, 'AI 暂不可用');
  assert.equal(modelStatusLabel({ ready: false, modelReady: false, access: 'needs-access-code' }).label, 'AI 暂不可用');
});

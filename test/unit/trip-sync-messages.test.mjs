import test from 'node:test';
import assert from 'node:assert/strict';
import { tripSyncErrorMessage } from '../../src/lib/tripSyncMessages.js';

test('a routebook that only exists on this device is not reported as deleted', () => {
  const message = tripSyncErrorMessage({ code: 'ROUTEBOOK_NOT_FOUND', message: '路书不存在或已删除' });
  assert.doesNotMatch(message, /不存在或已删除/);
  assert.match(message, /只保存在本机/);
  assert.match(tripSyncErrorMessage({ message: '网络错误' }), /^行中计划仅保存在本机：网络错误$/);
});

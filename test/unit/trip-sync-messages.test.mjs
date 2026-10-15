import test from 'node:test';
import assert from 'node:assert/strict';
import { tripSyncErrorMessage } from '../../src/lib/tripSyncMessages.js';

test('a routebook that only exists on this device is not reported as deleted', () => {
  const message = tripSyncErrorMessage({ code: 'ROUTEBOOK_NOT_FOUND', message: '路书不存在或已删除' });
  assert.doesNotMatch(message, /不存在或已删除/);
  assert.match(message, /只保存在本机/);
  assert.equal(tripSyncErrorMessage({ message: '网络错误' }), '行中计划先存在这台设备上了，云端这次没同步上。');
  // only a real network failure promises the automatic retry (useTripCloudSync listens for 'online').
  assert.equal(tripSyncErrorMessage({ code: 'NETWORK_OFFLINE' }), '行中计划先存在这台设备上了，联网后会自动同步。');
});

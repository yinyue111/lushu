import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withoutCheckedPending } from '../../src/lib/enrichmentText.js';

test('checked fields drop their 待确认 wording; other text and unchecked fields stay', () => {
  assert.equal(withoutCheckedPending('地址待确认，开放时间待确认', { hours: true }), '地址待确认');
  assert.equal(withoutCheckedPending('营业时间待确认', { hours: true }), '');
  assert.equal(withoutCheckedPending('门票待确认（需实名预约）', { price: true }), '（需实名预约）');
  assert.equal(withoutCheckedPending('开放时间待确认，门票待确认', { price: true }), '开放时间待确认');
  assert.equal(withoutCheckedPending('开放时间待确认', {}), '开放时间待确认', 'nothing checked: unchanged');
  assert.equal(withoutCheckedPending('到点打卡', { price: true, hours: true }), '到点打卡');
  assert.equal(withoutCheckedPending(undefined, { hours: true }), '');
});

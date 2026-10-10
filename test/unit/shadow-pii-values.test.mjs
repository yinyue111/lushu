import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertNoPersonalData, containsPersonalValue, redactPublicText } from '../../server/shadow/privacy.mjs';

test('phone numbers in any formatting are detected by value', () => {
  for (const text of [
    '电话13812345678',
    '+86 138 1234 5678',
    '+8613812345678',
    '0086-138-1234-5678',
    '138.1234.5678',
    '联系 +86 138****5678',
    'a@b.co',
    '身份证 11010519491231002X'
  ])
    assert.equal(containsPersonalValue(text), true, text);
  for (const text of ['西湖 10:30 出发', '人均 128 元', '2026-10-10', '门票 60 元，营业 9:00-17:30', '杭州市西湖区龙井路 1 号', '坐标 30.2588,120.1525'])
    assert.equal(containsPersonalValue(text), false, text);
});

test('shadow payloads carrying a phone value are blocked and the error never echoes it', () => {
  const state = { stop_name: '断桥', notes: ['好吃', { contact: '订位打 138-1234-5678' }] };
  assert.throws(
    () => assertNoPersonalData(state),
    (/** @type {any} */ error) => {
      assert.match(error.message, /personal-data value blocked: state\.notes\[1\]\.contact/);
      assert.doesNotMatch(error.message, /1234/);
      return true;
    }
  );
  assert.doesNotThrow(() => assertNoPersonalData({ stop_name: '断桥', city: '杭州', notes: ['营业 9:00-17:30'] }));
  assert.equal(redactPublicText('订位 13812345678'), '订位 [手机号]');
});

test('the shadow pipeline cannot reach account data', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const dir = new URL('../../server/shadow/', import.meta.url);
  for (const name of await readdir(dir)) {
    const source = await readFile(new URL(name, dir), 'utf8');
    assert.doesNotMatch(source, /accounts\/|ACCOUNTS_LOG_PATH|auth_users|auth_sessions/, name);
  }
});

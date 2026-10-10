import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decryptEmail, emailHash, encryptEmail, maskEmail, normalizeEmail } from '../../server/accounts/email.mjs';
import { lockedError } from '../../server/accounts/throttle.mjs';
import { normalizeEmailCode } from '../../server/accounts/emailCodes.mjs';
import { codeMail } from '../../server/mail/templates.mjs';

test('email normalization: trim, full-width, lowercase; keeps dots and +tags', () => {
  assert.equal(normalizeEmail('  Alice.Trip+Hz@Example.COM '), 'alice.trip+hz@example.com');
  assert.equal(normalizeEmail('ａｌｉｃｅ＠ｑｑ．ｃｏｍ'), 'alice@qq.com');
  assert.equal(normalizeEmail('user@163。com'), 'user@163.com');
  for (const bad of ['', 'a', 'a@b', '@qq.com', 'a@@qq.com', 'a b@qq.com', 'a..b@qq.com', '.a@qq.com', 'a@-qq.com', `${'x'.repeat(65)}@qq.com`, 'a@qq.c']) {
    assert.equal(normalizeEmail(bad), '', bad);
  }
});

test('email mask, HMAC and encryption round-trip', () => {
  assert.equal(maskEmail('alice@qq.com'), 'al***@qq.com');
  assert.equal(maskEmail('a@qq.com'), 'a***@qq.com');
  assert.equal(emailHash('a@qq.com'), emailHash('a@qq.com'));
  assert.notEqual(emailHash('a@qq.com'), emailHash('b@qq.com'));
  const enc = encryptEmail('alice@qq.com');
  assert.ok(!enc.includes('alice'));
  assert.notEqual(enc, encryptEmail('alice@qq.com'), 'random IV per encryption');
  assert.equal(decryptEmail(enc), 'alice@qq.com');
  const tampered = enc.slice(0, -2) + (enc.endsWith('A') ? 'BB' : 'AA');
  assert.equal(decryptEmail(tampered), '');
  assert.equal(decryptEmail('garbage'), '');
});

test('email codes and copy', () => {
  assert.equal(normalizeEmailCode(' 12 34 56 '), '123456');
  assert.equal(normalizeEmailCode('１２３４５６'), '123456');
  const mail = codeMail('reset', '042917');
  assert.match(mail.subject, /042917/);
  assert.match(mail.text, /重设密码/);
  assert.doesNotMatch(mail.text, /https?:/, 'no links in code mails');
  const now = Date.now();
  assert.match(lockedError(now + 60 * 60 * 1000, now, 'mailto:x').message, /验证码发得太频繁了，60 分钟后再试/);
  assert.match(lockedError(now + 30 * 60 * 1000, now, 'code:x').message, /验证码错太多次了/);
});

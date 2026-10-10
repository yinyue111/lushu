import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizePhone, maskPhone, phoneHash, phoneLast4 } from '../../server/accounts/phone.mjs';
import { hashPassword, verifyPassword, passwordPolicyError, passwordNeedsRehash } from '../../server/accounts/password.mjs';
import { issueChallenge, solveChallenge, assertHumanCheck } from '../../server/accounts/pow.mjs';

test('phone normalization accepts mainland mobiles in common shapes only', () => {
  for (const input of ['13812345678', '138 1234 5678', '138-1234-5678', '+8613812345678', '008613812345678', '8613812345678', '１３８１２３４５６７８'])
    assert.equal(normalizePhone(input), '+8613812345678', input);
  for (const input of ['', '1381234567', '12812345678', '+12025550123', '23812345678', 'abc', '138123456789']) assert.equal(normalizePhone(input), '', input);
  assert.equal(maskPhone('+8613812345678'), '+86 138****5678');
  assert.equal(phoneLast4('+86 138****5678'), '5678');
});

test('phone hash is keyed, stable and never contains the number', () => {
  const hash = phoneHash('+8613812345678');
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(hash, phoneHash('+8613812345678'));
  assert.notEqual(hash, phoneHash('+8613812345679'));
  assert.ok(!hash.includes('13812345678'));
});

test('password policy', () => {
  assert.equal(passwordPolicyError('short'), 'PASSWORD_TOO_SHORT');
  assert.equal(passwordPolicyError('12345678'), 'PASSWORD_TOO_COMMON');
  assert.equal(passwordPolicyError('aaaaaaaaaaa'), 'PASSWORD_TOO_COMMON');
  assert.equal(passwordPolicyError('x12345678y', { phone: '+8613812345678' }), 'PASSWORD_CONTAINS_PHONE');
  assert.equal(passwordPolicyError('x'.repeat(73)), 'PASSWORD_TOO_LONG');
  assert.equal(passwordPolicyError('西湖边走一走2026'), '');
});

test('scrypt hashes are versioned, salted and verify in constant work', async () => {
  const a = await hashPassword('correct horse 1');
  const b = await hashPassword('correct horse 1');
  assert.match(a, /^scrypt\$v1\$15\$8\$1\$/);
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('correct horse 1', a), true);
  assert.equal(await verifyPassword('correct horse 2', a), false);
  assert.equal(await verifyPassword('anything', ''), false);
  assert.equal(await verifyPassword('anything', 'garbage'), false);
  assert.equal(passwordNeedsRehash(a), false);
  const weak = await hashPassword('correct horse 1', { version: 'v1', logN: 12, r: 8, p: 1, keyLength: 64 });
  assert.equal(await verifyPassword('correct horse 1', weak), true);
  assert.equal(passwordNeedsRehash(weak), true);
});

test('human check: signed, purpose-bound, single use', () => {
  const { challenge, difficulty } = issueChallenge('register');
  const nonce = solveChallenge(challenge, difficulty);
  assert.throws(() => assertHumanCheck({ challenge, nonce }, 'login'), /安全检查/);
  assertHumanCheck({ challenge, nonce }, 'register');
  assert.throws(() => assertHumanCheck({ challenge, nonce }, 'register'), /安全检查/);
  assert.throws(() => assertHumanCheck({ challenge: challenge.replace(/.$/, '0'), nonce }, 'register'));
  assert.throws(
    () => assertHumanCheck({}, 'register'),
    (/** @type {any} */ e) => e.code === 'HUMAN_CHECK_REQUIRED'
  );
});

test('lock messages fit the action: sign-up pauses do not suggest a password reset', async () => {
  const { lockedError } = await import('../../server/accounts/throttle.mjs');
  const now = Date.now();
  assert.match(lockedError(now + 30 * 60 * 1000, now, 'register:abc').message, /注册得太频繁了，30 分钟后再试/);
  assert.match(lockedError(now + 15 * 60 * 1000, now, 'phone:abc').message, /15 分钟后再试，或者点「忘了密码？」用邮箱或恢复码重设/);
});

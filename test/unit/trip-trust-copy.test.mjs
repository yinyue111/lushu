import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Profiles are server-issued device identities (SMS / WeChat login is not live), so a counted check-in must not claim 实名.
test('trip evidence copy never claims real-name verification that does not exist yet', () => {
  const source = readFileSync(new URL('../../src/components/Trip/tripModel.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /实名身份/);
  assert.match(source, /尚未接入实名认证/);
});

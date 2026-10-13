import test from 'node:test';
import assert from 'node:assert/strict';
import { raiseAlert, resetAlertThrottleForTests } from '../server/ops/alerts.mjs';

test('alert posts once per hour per type and skips without webhook', async () => {
  resetAlertThrottleForTests();
  delete process.env.ALERT_WEBHOOK_URL;
  assert.equal((await raiseAlert('x', 'm', { now: 0 })).reason, 'no-webhook');
  resetAlertThrottleForTests();
  process.env.ALERT_WEBHOOK_URL = 'https://hook.example/a';
  const calls = [];
  const fetchImpl = async (url, init) => (calls.push([url, JSON.parse(init.body)]), { ok: true, status: 200 });
  assert.equal((await raiseAlert('x', 'm', { now: 1000, fetchImpl })).sent, true);
  assert.equal((await raiseAlert('x', 'm', { now: 2000, fetchImpl })).reason, 'throttled');
  assert.equal((await raiseAlert('y', 'm', { now: 2000, fetchImpl })).sent, true);
  assert.equal((await raiseAlert('x', 'm', { now: 1000 + 3_600_001, fetchImpl })).sent, true);
  assert.equal(calls.length, 3);
  assert.equal(calls[0][1].type, 'x');
  delete process.env.ALERT_WEBHOOK_URL;
});

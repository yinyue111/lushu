import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchJson, startServer } from '../helpers/server.mjs';
import { authEnv, createClient } from '../helpers/accounts.mjs';

test('open registration (default): no invite code needed; signed-in user needs no access code', async (t) => {
  const env = authEnv('both');
  delete env.REGISTRATION_MODE;
  const server = await startServer({ env });
  t.after(server.stop);
  const config = await fetchJson(`${server.baseUrl}/api/auth/config`);
  assert.equal(config.data.registration, 'open');
  const anon = await fetchJson(`${server.baseUrl}/api/health`);
  assert.equal(anon.data.access, 'needs-login', 'anonymous users are pointed at login, not the access code');
  const guest = createClient(server.baseUrl);
  const reg = await guest.register('13800138111', 'Lushu-open-2026', { inviteCode: undefined });
  assert.equal(reg.status, 200, JSON.stringify(reg.data));
  const health = await guest.request('/api/health');
  assert.notEqual(health.data.access, 'needs-access-code');
  assert.notEqual(health.data.access, 'needs-login');
});

test('invite switch still works when re-enabled', async (t) => {
  const server = await startServer({ env: authEnv('both') });
  t.after(server.stop);
  const guest = createClient(server.baseUrl);
  const reg = await guest.register('13800138112', 'Lushu-open-2026', { inviteCode: 'wrong' });
  assert.equal(reg.data.code, 'INVITE_CODE_INVALID');
});

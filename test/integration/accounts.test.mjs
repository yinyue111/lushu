import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { API_TOKEN, adminHeaders, fetchJson, jsonHeaders, startServer } from '../helpers/server.mjs';
import { INVITE, authEnv, createClient } from '../helpers/accounts.mjs';

const PHONE = '13812345678';
const PASSWORD = '西湖边走一走2026';

async function dataDirText(dir) {
  let text = '';
  for (const name of await readdir(dir)) if (name.endsWith('.jsonl')) text += await readFile(join(dir, name), 'utf8');
  return text;
}

test('AUTH_MODE=access-code keeps today’s behaviour: account API is off', async (t) => {
  const server = await startServer();
  t.after(server.stop);
  const client = createClient(server.baseUrl);
  assert.equal((await client.request('/api/auth/me')).data.account, null);
  assert.equal((await client.request('/api/auth/register', { method: 'POST', body: {} })).status, 404);
  const generation = await client.request('/api/import-guide', { method: 'POST', body: { urls: ['https://example.com'] } });
  assert.equal(generation.data.code, 'ACCESS_CODE_REQUIRED');
});

test('login mode: register, sessions, enumeration-safe login, lockout, recovery, CSRF, logout', async (t) => {
  const server = await startServer({ env: authEnv('login') });
  t.after(server.stop);
  const guest = createClient(server.baseUrl);

  // Planning needs a login; the old access code no longer opens it.
  const blocked = await guest.request('/api/import-guide', {
    method: 'POST',
    body: { urls: ['https://example.com'] },
    headers: { 'x-routebook-token': API_TOKEN }
  });
  assert.equal(blocked.status, 401);
  assert.equal(blocked.data.code, 'LOGIN_REQUIRED');
  assert.equal((await guest.request('/api/health')).data.access, 'needs-login');
  assert.equal((await guest.request('/api/routebooks', { method: 'POST', body: { title: 'x', city: '杭州', stops: [] } })).data.code, 'LOGIN_REQUIRED');

  // Registration: invite code, human check, privacy consent, password policy.
  assert.equal((await guest.register(PHONE, PASSWORD, { inviteCode: 'wrong' })).data.code, 'INVITE_CODE_INVALID');
  assert.equal(
    (await guest.request('/api/auth/register', { method: 'POST', body: { phone: PHONE, password: PASSWORD, inviteCode: INVITE, acceptPrivacy: true } })).data
      .code,
    'HUMAN_CHECK_REQUIRED'
  );
  assert.equal((await guest.register(PHONE, PASSWORD, { acceptPrivacy: false })).data.code, 'PRIVACY_CONSENT_REQUIRED');
  assert.equal((await guest.register(PHONE, '12345678')).data.code, 'PASSWORD_TOO_COMMON');
  assert.equal((await guest.register('12345', PASSWORD)).data.code, 'PHONE_INVALID');

  const alice = createClient(server.baseUrl);
  const registered = await alice.register(PHONE, PASSWORD);
  assert.equal(registered.status, 200, JSON.stringify(registered.data));
  assert.equal(registered.data.recoveryCodes.length, 6);
  assert.match(registered.data.recoveryCodes[0], /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(registered.data.account.phoneMasked, '+86 138****5678');
  assert.match(alice.cookie, /^__Host-lushu_sid=/);
  const setCookie = registered.response.headers.getSetCookie().join('\n');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Path=\//);
  assert.doesNotMatch(setCookie, /Domain=/i);
  const me = await alice.request('/api/auth/me');
  assert.equal(me.data.account.phoneMasked, '+86 138****5678');
  assert.equal(me.data.account.recoveryCodesLeft, 6);
  assert.equal((await alice.request('/api/health')).data.access, 'open');

  // Duplicate numbers are refused (same message whichever device asks).
  assert.equal((await createClient(server.baseUrl).register('+86 138-1234-5678', `${PASSWORD}x`, { email: 'other@example.com' })).data.code, 'PHONE_TAKEN');

  // Wrong password and unknown phone look identical.
  const wrong = await createClient(server.baseUrl).login(PHONE, 'not-the-password');
  const unknown = await createClient(server.baseUrl).login('13900000000', 'not-the-password');
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual({ ...wrong.data, requestId: '' }, { ...unknown.data, requestId: '' });

  // Session rotation: logging in again issues a different sid.
  const bob = createClient(server.baseUrl);
  const firstLogin = await bob.login(PHONE, PASSWORD);
  assert.equal(firstLogin.status, 200, JSON.stringify(firstLogin.data));
  const firstSid = bob.cookie;
  await bob.login(PHONE, PASSWORD);
  assert.notEqual(bob.cookie, firstSid);
  const stale = createClient(server.baseUrl);
  stale.cookie = firstSid;
  assert.equal((await stale.request('/api/auth/me')).data.account, null, 'the replaced session is revoked');

  // CSRF: cookie-authenticated writes must come from this site; bodies need a JSON content type.
  const crossSite = await alice.request('/api/auth/logout', { method: 'POST', body: {}, headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(crossSite.data.code, 'CSRF_REJECTED');
  const evilOrigin = await alice.request('/api/auth/logout', { method: 'POST', body: {}, headers: { origin: 'https://evil.example' } });
  assert.equal(evilOrigin.data.code, 'CSRF_REJECTED');
  const noType = await fetchJson(`${server.baseUrl}/api/auth/logout`, {
    method: 'POST',
    headers: { cookie: alice.cookie, 'sec-fetch-site': 'same-origin' },
    body: '{}'
  });
  assert.equal(noType.status, 415);
  assert.ok((await alice.request('/api/auth/me')).data.account, 'rejected requests did not log out');

  // Lockout: 5 wrong passwords lock the phone, even for the right password afterwards.
  const mallory = createClient(server.baseUrl);
  for (let i = 0; i < 5; i += 1) await mallory.login(PHONE, `wrong-${i}-password`, { humanCheck: await mallory.humanCheck('login') });
  const locked = await mallory.login(PHONE, PASSWORD, { humanCheck: await mallory.humanCheck('login') });
  assert.equal(locked.status, 429);
  assert.equal(locked.data.code, 'AUTH_LOCKED');
  // After several failures this client must also solve the human check.
  const noCheck = await mallory.login('13700000000', 'whatever-password');
  assert.ok(['HUMAN_CHECK_REQUIRED', 'AUTH_LOCKED'].includes(noCheck.data.code), noCheck.data.code);

  // Recovery code resets the password, works once, and ends every other session.
  const code = registered.data.recoveryCodes[0];
  const recovering = createClient(server.baseUrl);
  const reset = await recovering.request('/api/auth/reset-password', {
    method: 'POST',
    body: { phone: PHONE, recoveryCode: code.toLowerCase(), password: '新的密码也要够长', humanCheck: await recovering.humanCheck('reset') }
  });
  assert.equal(reset.status, 200, JSON.stringify(reset.data));
  assert.equal(reset.data.account.recoveryCodesLeft, 5);
  assert.equal((await alice.request('/api/auth/me')).data.account, null, 'reset revoked the old sessions');
  const reuse = await createClient(server.baseUrl).request('/api/auth/reset-password', {
    method: 'POST',
    body: { phone: PHONE, recoveryCode: code, password: '再换一个也够长的', humanCheck: await recovering.humanCheck('reset') }
  });
  assert.equal(reuse.data.code, 'INVALID_RECOVERY');

  // Change password: needs the current one, rotates this session, ends the others.
  const other = createClient(server.baseUrl);
  await assert.doesNotReject(async () => assert.equal((await other.request('/api/auth/me')).data.account, null));
  assert.equal(
    (await recovering.request('/api/auth/password', { method: 'POST', body: { currentPassword: 'nope', password: '第三个够长的密码' } })).data.code,
    'PASSWORD_MISMATCH'
  );
  const before = recovering.cookie;
  const changed = await recovering.request('/api/auth/password', {
    method: 'POST',
    body: { currentPassword: '新的密码也要够长', password: '第三个够长的密码' }
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.data));
  assert.notEqual(recovering.cookie, before);

  // Regenerate recovery codes (password required).
  const regenerated = await recovering.request('/api/auth/recovery-codes', { method: 'POST', body: { password: '第三个够长的密码' } });
  assert.equal(regenerated.data.recoveryCodes.length, 6);

  // Logout everywhere.
  const second = createClient(server.baseUrl);
  await second.login(PHONE, '第三个够长的密码', { humanCheck: await second.humanCheck('login') });
  assert.ok((await second.request('/api/auth/me')).data.account);
  await recovering.request('/api/auth/logout-all', { method: 'POST', body: {} });
  assert.equal((await second.request('/api/auth/me')).data.account, null);
  assert.equal((await recovering.request('/api/auth/me')).data.account, null);

  // No phone number, password or sid in any stored file.
  const stored = await dataDirText(server.dataDir);
  for (const secret of ['13812345678', PASSWORD, '新的密码也要够长', '第三个够长的密码', firstSid.split('=')[1], code]) {
    assert.ok(!stored.includes(secret), `stored data leaks ${secret.slice(0, 3)}…`);
  }
  assert.ok(!server.output.join('').includes('13812345678'), 'server logs never contain the phone');
});

test('both mode: guest drafts are claimed on login, which fixes the trip-sync 403', async (t) => {
  const server = await startServer({ env: authEnv('both') });
  t.after(server.stop);
  const browser = createClient(server.baseUrl);
  const created = await browser.request('/api/routebooks', {
    method: 'POST',
    body: {
      title: '登录前的草稿',
      city: '杭州',
      stops: [
        { name: '柳浪闻莺', day: 1 },
        { name: '南宋御街', day: 1 }
      ]
    }
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const { publicId, editToken, stops } = created.data.routebook;
  assert.equal(created.data.routebook.profileId, 'anonymous');

  const registered = await browser.register('13912345678', PASSWORD);
  const profileId = registered.data.account.profileId;
  const trip = { profileId, stops, currentStopId: String(stops[0].id), expectedRevision: 0 };
  const forbidden = await browser.request(`/api/trip-sessions/${publicId}`, { method: 'POST', body: trip });
  assert.equal(forbidden.data.code, 'TRIP_SESSION_ROUTE_FORBIDDEN', 'the bug this claim fixes');

  const wrongToken = await browser.request('/api/auth/claim', { method: 'POST', body: { drafts: [{ id: publicId, editToken: 'x'.repeat(32) }] } });
  assert.equal(wrongToken.data.claimed, 0);
  assert.equal(wrongToken.data.skipped, 1);
  const before = browser.cookie;
  const claim = await browser.request('/api/auth/claim', { method: 'POST', body: { drafts: [{ id: publicId, editToken }] } });
  assert.equal(claim.data.claimed, 1, JSON.stringify(claim.data));
  assert.notEqual(browser.cookie, before, 'claim rotates the session');
  const again = await browser.request('/api/auth/claim', { method: 'POST', body: { drafts: [{ id: publicId, editToken }] } });
  assert.equal(again.data.alreadyYours, 1);

  const synced = await browser.request(`/api/trip-sessions/${publicId}`, { method: 'POST', body: trip });
  assert.equal(synced.status, 200, JSON.stringify(synced.data));
  const read = await browser.request(`/api/routebooks/${publicId}`);
  assert.equal(read.data.routebook.profileId, profileId);

  // Someone else's account cannot claim it, even with the token.
  const thief = createClient(server.baseUrl);
  await thief.register('13712345678', PASSWORD);
  const stolen = await thief.request('/api/auth/claim', { method: 'POST', body: { drafts: [{ id: publicId, editToken }] } });
  assert.equal(stolen.data.claimed, 0);

  // both mode keeps the access code working for guests.
  const guest = await createClient(server.baseUrl).request('/api/import-guide', {
    method: 'POST',
    body: { urls: ['https://example.com/a'] },
    headers: { 'x-routebook-token': API_TOKEN }
  });
  assert.notEqual(guest.status, 401);
  assert.notEqual(guest.status, 403);
});

test('ops: masked search, disable/enable, one-time recovery with audit, quota; account delete', async (t) => {
  const server = await startServer({ env: authEnv('login') });
  t.after(server.stop);
  const user = createClient(server.baseUrl);
  await user.register('13612345678', PASSWORD);
  const ops = (path, init = {}) =>
    fetchJson(`${server.baseUrl}${path}`, { ...init, headers: jsonHeaders(adminHeaders()), ...(init.body ? { body: JSON.stringify(init.body) } : {}) });
  assert.equal((await fetchJson(`${server.baseUrl}/api/ops/users?q=5678`)).status, 403, 'admin token required');
  const list = await ops('/api/ops/users?q=5678');
  assert.equal(list.status, 200, JSON.stringify(list.data));
  assert.equal(list.data.users.length, 1);
  const found = list.data.users[0];
  assert.equal(found.phoneMasked, '+86 136****5678');
  assert.ok(!JSON.stringify(list.data).includes('passwordHash'));
  assert.equal((await ops('/api/ops/users?q=13612345678')).data.users.length, 1);
  assert.equal((await ops(`/api/ops/users/${found.id}`, { method: 'POST', body: { action: 'disable' } })).data.code, 'OPS_REASON_REQUIRED');

  assert.equal((await ops(`/api/ops/users/${found.id}`, { method: 'POST', body: { action: 'disable', reason: '用户报告被盗' } })).status, 200);
  assert.equal((await user.request('/api/auth/me')).data.account, null, 'disabling ends sessions');
  assert.equal((await createClient(server.baseUrl).login('13612345678', PASSWORD)).data.code, 'ACCOUNT_DISABLED');
  await ops(`/api/ops/users/${found.id}`, { method: 'POST', body: { action: 'enable', reason: '核实后恢复' } });

  const issued = await ops(`/api/ops/users/${found.id}`, { method: 'POST', body: { action: 'issue-recovery', reason: '电话核实本人后补发' } });
  assert.match(issued.data.recoveryCode, /^[A-Z2-9-]{14}$/);
  const quota = await ops(`/api/ops/users/${found.id}`, { method: 'POST', body: { action: 'set-quota', quota: 2, reason: '内测加额度' } });
  assert.equal(quota.data.user.generationQuota, 2);
  const recover = createClient(server.baseUrl);
  const reset = await recover.request('/api/auth/reset-password', {
    method: 'POST',
    body: { phone: '13612345678', recoveryCode: issued.data.recoveryCode, password: '运维补发后重设的密码', humanCheck: await recover.humanCheck('reset') }
  });
  assert.equal(reset.status, 200, JSON.stringify(reset.data));
  const audits = await readFile(join(server.dataDir, 'ops-audits.jsonl'), 'utf8');
  assert.match(audits, /"action":"issue-recovery"/);
  assert.match(audits, /电话核实本人后补发/);
  assert.ok(!audits.includes(issued.data.recoveryCode), 'the code itself is never stored');

  // Delete account: password required; the number can register again afterwards.
  assert.equal((await recover.request('/api/auth/delete', { method: 'POST', body: { password: 'nope' } })).data.code, 'PASSWORD_MISMATCH');
  const deleted = await recover.request('/api/auth/delete', { method: 'POST', body: { password: '运维补发后重设的密码' } });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
  assert.equal((await recover.request('/api/auth/me')).data.account, null);
  assert.equal((await createClient(server.baseUrl).register('13612345678', PASSWORD)).status, 200);
});

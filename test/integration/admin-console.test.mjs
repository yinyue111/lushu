// Admin console over HTTP: separate login + TOTP, roles, CSRF, denied-attempt audit, script token cannot
// open admin APIs, runtime config applies without restart (registration mode, invite codes, open cities).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADMIN_TOKEN, PROJECT_ROOT, fetchJson, startServer } from '../helpers/server.mjs';
import { authEnv, createClient } from '../helpers/accounts.mjs';
import { hermeticServerEnv } from '../../scripts/lib/hermetic-env.mjs';
import { totpAt, totpStep } from '../../server/admin/totp.mjs';

const ENV = authEnv('login', { REGISTRATION_MODE: 'open', ADMIN_ENABLED: 'true', CONFIG_ENC_KEY: 'unit-test-config-enc-key-0123456789', ADMIN_CONFIG_POLL_MS: '200' });

function createAdmin(dataDir, username, role) {
  const env = hermeticServerEnv({ NODE_ENV: 'production', ROUTEBOOK_DATA_DIR: dataDir, PROFILE_ID_SECRET: 'unit-test-profile-secret', ...ENV });
  const out = spawnSync(process.execPath, ['scripts/admin-create.mjs', '--username', username, '--role', role, '--production'], { cwd: PROJECT_ROOT, env, encoding: 'utf8' });
  const password = /shown once\): (\S+)/.exec(out.stdout)?.[1];
  assert.ok(password, out.stdout + out.stderr);
  return password;
}

function adminClient(baseUrl) {
  const client = createClient(baseUrl);
  let csrf = '';
  return Object.assign(client, {
    setCsrf(v) {
      csrf = v;
    },
    get: (path) => client.request(path),
    write: (path, body = {}, headers = {}) => client.request(path, { method: 'POST', body, headers: { 'x-admin-csrf': csrf, ...headers } })
  });
}

async function enroll(client, username, password) {
  const first = await client.request('/api/admin/login', { method: 'POST', body: { username, password } });
  assert.equal(first.status, 200);
  assert.ok(first.data.enroll?.otpauthUrl.startsWith('otpauth://totp/'));
  const { token, secret } = first.data.enroll;
  const wrong = await client.request('/api/admin/enroll', { method: 'POST', body: { token, totp: '000000' } });
  assert.equal(wrong.status, 400);
  const done = await client.request('/api/admin/enroll', { method: 'POST', body: { token, totp: totpAt(secret, totpStep()) } });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal(done.data.backupCodes.length, 8);
  client.setCsrf(done.data.csrfToken);
  return { secret, backupCodes: done.data.backupCodes };
}

test('admin console end to end (JSONL backend)', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'admin-it-'));
  const rootPassword = createAdmin(dataDir, 'root', 'admin');
  const opPassword = createAdmin(dataDir, 'opsone', 'operator');
  const server = await startServer({ dataDir, env: ENV });
  try {
    const root = adminClient(server.baseUrl);
    const op = adminClient(server.baseUrl);

    // Nothing opens without a session; the script token never opens admin APIs.
    assert.equal((await root.get('/api/admin/dashboard')).status, 401);
    assert.equal((await fetchJson(`${server.baseUrl}/api/admin/config`, { headers: { 'x-routebook-admin-token': ADMIN_TOKEN } })).status, 401);
    // ...but it still works for the existing script endpoints.
    assert.equal((await fetchJson(`${server.baseUrl}/api/ops/enrichment`, { headers: { 'x-routebook-admin-token': ADMIN_TOKEN } })).status, 200);

    // Password alone is not enough: TOTP must be bound first.
    const rootTotp = await enroll(root, 'root', rootPassword);
    await enroll(op, 'opsone', opPassword);
    const me = await root.get('/api/admin/me');
    assert.equal(me.data.admin.role, 'admin');
    assert.ok(!JSON.stringify(me.data).includes('passwordHash') && !JSON.stringify(me.data).includes('totpSecret'));

    // Writes need the CSRF header.
    const noCsrf = await root.request('/api/admin/config', { method: 'POST', body: { values: { 'generation.dailyLimit': 5 }, reason: '没有令牌' } });
    assert.equal(noCsrf.status, 403);
    assert.equal(noCsrf.data.code, 'ADMIN_CSRF_INVALID');

    // Runtime config applies without restart: invite mode + open cities.
    const before = await fetchJson(`${server.baseUrl}/api/cities`);
    assert.equal(before.data.openRegion, 'jzh');
    const saved = await root.write('/api/admin/config', { values: { 'registration.mode': 'invite', 'generation.openCities': ['杭州', '上海', '苏州'] }, reason: '内测收紧' });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    const authCfg = await fetchJson(`${server.baseUrl}/api/auth/config`);
    assert.equal(authCfg.data.registration, 'invite');
    const after = await fetchJson(`${server.baseUrl}/api/cities`);
    assert.equal(after.data.total, 3);
    assert.deepEqual(after.data.recommended, ['杭州', '上海', '苏州']);
    const health = await fetchJson(`${server.baseUrl}/api/health`);
    assert.equal(health.data.configVersion, saved.data.version);

    // Invite codes: create, use, revoke.
    const created = await root.write('/api/admin/invites', { label: '朋友内测', maxUses: 1 });
    assert.match(created.data.code, /^[A-Z2-9]{4}-[A-Z2-9]{6}$/);
    const listed = await root.get('/api/admin/invites');
    assert.ok(!JSON.stringify(listed.data).includes(created.data.code), 'plain code is shown only once');
    const user = createClient(server.baseUrl);
    const reg = await user.register('13700000001', '足够长的测试密码一', { inviteCode: created.data.code });
    assert.equal(reg.status, 200, JSON.stringify(reg.data));
    const user2 = createClient(server.baseUrl);
    const reused = await user2.register('13700000002', '足够长的测试密码二', { inviteCode: created.data.code });
    assert.equal(reused.status, 403, 'max uses reached');
    const second = await root.write('/api/admin/invites', { label: '撤销用', maxUses: 5 });
    await root.write(`/api/admin/invites/${second.data.invite.id}/revoke`, { reason: '邀请码泄露了' });
    const revoked = await user2.register('13700000002', '足够长的测试密码二', { inviteCode: second.data.code });
    assert.equal(revoked.status, 403);

    // Operator: cannot write config (403 + audited), can search users, quota capped.
    const denied = await op.write('/api/admin/config', { values: { 'generation.dailyLimit': 1 }, reason: '越权尝试' });
    assert.equal(denied.status, 403);
    const opCfg = await op.get('/api/admin/config');
    assert.equal(opCfg.status, 200, 'operators can read config (no secrets)');
    const found = await op.get('/api/admin/users?q=13700000001');
    assert.equal(found.data.users.length, 1);
    const target = found.data.users[0];
    assert.ok(!/recovery|password|token/i.test(Object.keys(target).join(',')));
    assert.equal((await op.write(`/api/admin/users/${target.id}`, { action: 'set-quota', quota: 50, reason: '加点额度' })).status, 403);
    assert.equal((await op.write(`/api/admin/users/${target.id}`, { action: 'set-quota', quota: 10, reason: '加点额度' })).status, 200);
    assert.equal((await op.write(`/api/admin/users/${target.id}`, { action: 'reset-quota', reason: '误扣次数' })).status, 200);
    const banned = await op.write(`/api/admin/users/${target.id}`, { action: 'ban', reason: '刷接口太多' });
    assert.equal(banned.data.user?.status, 'disabled', JSON.stringify(banned.data));

    const audit = await root.get('/api/admin/audit');
    assert.ok(audit.data.items.some((e) => e.action === 'denied' && e.actor === 'opsone' && e.target === 'config.write'));
    const ownAudit = await op.get('/api/admin/audit');
    assert.equal(ownAudit.data.scope, 'own');
    assert.ok(ownAudit.data.items.every((e) => e.actor === 'opsone'));

    // Restore previous version in one call.
    const versions = await root.get('/api/admin/config/versions');
    assert.ok(versions.data.versions.length >= 1);
    const restored = await root.write(`/api/admin/config/versions/0/restore`, { reason: '回到初始' });
    assert.equal(restored.status, 404, 'version 0 (env) is not a stored version');
    const exported = await root.get(`/api/admin/config/versions/${saved.data.version}/export`);
    assert.equal(exported.data.format, 'lushu-runtime-config');
    assert.equal((await op.get(`/api/admin/config/versions/${saved.data.version}/export`)).status, 403);

    // Backup code logs in once; lockout after 5 wrong attempts.
    const viaBackup = adminClient(server.baseUrl);
    const b = await viaBackup.request('/api/admin/login', { method: 'POST', body: { username: 'root', password: rootPassword, backupCode: rootTotp.backupCodes[0] } });
    assert.equal(b.status, 200);
    const again = await viaBackup.request('/api/admin/login', { method: 'POST', body: { username: 'root', password: rootPassword, backupCode: rootTotp.backupCodes[0] } });
    assert.equal(again.status, 401, 'backup codes are one-time');
    for (let i = 0; i < 5; i += 1) await viaBackup.request('/api/admin/login', { method: 'POST', body: { username: 'opsone', password: 'wrong-password-xx' } });
    const locked = await viaBackup.request('/api/admin/login', { method: 'POST', body: { username: 'opsone', password: opPassword, totp: '123456' } });
    assert.equal(locked.status, 429);

    // System info is read-only and never guesses.
    const sys = await root.get('/api/admin/system');
    assert.equal(sys.data.imageDigest, 'unknown');
    assert.equal(sys.data.migration.expectedSchemaVersion, 12);
  } finally {
    await server.stop();
  }
});

test('admin console is off in production unless ADMIN_ENABLED=true', async () => {
  const server = await startServer();
  try {
    assert.equal((await fetchJson(`${server.baseUrl}/api/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404);
  } finally {
    await server.stop();
  }
});

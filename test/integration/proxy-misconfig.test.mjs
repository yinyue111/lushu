// Runtime proxy-misconfig safeguard over HTTP (production server, admin session, local webhook):
//   good: the TCP peer (127.0.0.1) is in TRUSTED_PROXY_CIDRS -> forwarded requests count nothing.
//   bad:  the peer is not trusted (containerized Caddy without the override) -> one [proxy] warning,
//         the admin overview flag, exactly one webhook POST.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROJECT_ROOT, startServer } from '../helpers/server.mjs';
import { authEnv, createClient } from '../helpers/accounts.mjs';
import { hermeticServerEnv } from '../../scripts/lib/hermetic-env.mjs';
import { totpAt, totpStep } from '../../server/admin/totp.mjs';

async function webhook() {
  const posts = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => (posts.push(JSON.parse(body)), res.end('ok')));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  return { url: `http://127.0.0.1:${/** @type {any} */ (server.address()).port}/hook`, posts, close: () => server.close() };
}

async function scenario(trustedCidrs) {
  const hook = await webhook();
  const ENV = authEnv('login', {
    ADMIN_ENABLED: 'true',
    CONFIG_ENC_KEY: 'unit-test-config-enc-key-0123456789',
    TRUST_PROXY_HEADERS: 'true',
    TRUSTED_PROXY_CIDRS: trustedCidrs,
    PROXY_MISCONFIG_THRESHOLD: '5',
    ALERT_WEBHOOK_URL: hook.url
  });
  const dataDir = await mkdtemp(join(tmpdir(), 'proxy-misconfig-it-'));
  const env = hermeticServerEnv({ NODE_ENV: 'production', ROUTEBOOK_DATA_DIR: dataDir, PROFILE_ID_SECRET: 'unit-test-profile-secret', ...ENV });
  const created = spawnSync(process.execPath, ['scripts/admin-create.mjs', '--username', 'root', '--role', 'admin', '--production'], {
    cwd: PROJECT_ROOT,
    env,
    encoding: 'utf8'
  });
  const password = /shown once\): (\S+)/.exec(created.stdout)?.[1];
  assert.ok(password, created.stdout + created.stderr);
  const server = await startServer({ dataDir, env: ENV });
  try {
    const admin = createClient(server.baseUrl);
    const first = await admin.request('/api/admin/login', { method: 'POST', body: { username: 'root', password } });
    const { token, secret } = first.data.enroll;
    assert.equal((await admin.request('/api/admin/enroll', { method: 'POST', body: { token, totp: totpAt(secret, totpStep()) } })).status, 200);
    for (let i = 0; i < 12; i++) await fetch(`${server.baseUrl}/api/live`, { headers: { 'x-forwarded-for': `198.51.100.${i}` } });
    await new Promise((r) => setTimeout(r, 300));
    const dash = await admin.request('/api/admin/dashboard');
    assert.equal(dash.status, 200, JSON.stringify(dash.data));
    return { dash: dash.data, posts: [...hook.posts], log: server.output.join('') };
  } finally {
    await server.stop();
    hook.close();
  }
}

test('correct proxy config: forwarded requests from a trusted peer count nothing', async () => {
  const { dash, posts, log } = await scenario('127.0.0.1,::1');
  assert.equal(dash.proxyMisconfig.count, 0);
  assert.equal(dash.proxyMisconfig.tripped, false);
  assert.ok(!dash.warnings.some((w) => w.key === 'proxy-misconfig'));
  assert.equal(posts.length, 0);
  assert.doesNotMatch(log, /\[proxy\] WARNING/);
});

test('misconfig: untrusted peer + X-Forwarded-For -> one warn, overview flag, one webhook', async () => {
  const { dash, posts, log } = await scenario('10.9.9.9');
  assert.equal(dash.proxyMisconfig.tripped, true, JSON.stringify(dash.proxyMisconfig));
  assert.ok(dash.proxyMisconfig.count >= 12);
  assert.equal(dash.proxyMisconfig.lastPeer, '127.0.0.1');
  const flag = dash.warnings.find((w) => w.key === 'proxy-misconfig');
  assert.equal(flag?.tone, 'error');
  assert.equal(flag?.text, '代理配置疑似有误，所有用户可能共用限流额度，请联系 SRE。');
  assert.equal((log.match(/\[proxy\] WARNING/g) ?? []).length, 1, log);
  assert.match(log, /untrusted peer 127\.0\.0\.1/);
  assert.doesNotMatch(log, /198\.51\.100/);
  assert.equal(posts.length, 1, JSON.stringify(posts));
  assert.equal(posts[0].type, 'proxy-misconfig');
});

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

async function scenario(trustedCidrs, extraEnv = {}, xff = (i) => `198.51.100.${i}`, n = 12) {
  const hook = await webhook();
  const ENV = authEnv('login', {
    ADMIN_ENABLED: 'true',
    CONFIG_ENC_KEY: 'unit-test-config-enc-key-0123456789',
    TRUST_PROXY_HEADERS: 'true',
    TRUSTED_PROXY_CIDRS: trustedCidrs,
    PROXY_MISCONFIG_THRESHOLD: '5',
    ALERT_WEBHOOK_URL: hook.url,
    ...extraEnv
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
    for (let i = 0; i < n; i++) await fetch(`${server.baseUrl}/api/live`, { headers: { 'x-forwarded-for': xff(i) } });
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
  assert.ok(Date.parse(dash.proxyMisconfig.lastSeenAt) > Date.now() - 60_000);
  assert.equal(flag.lastSeenAt, dash.proxyMisconfig.lastSeenAt);
  assert.equal(flag.processLocal, true);
  assert.equal((log.match(/\[proxy\] WARNING/g) ?? []).length, 1, log);
  assert.match(log, /untrusted peer 127\.0\.0\.1/);
  assert.doesNotMatch(log, /198\.51\.100/);
  assert.equal(posts.length, 1, JSON.stringify(posts));
  assert.equal(posts[0].type, 'proxy-misconfig');
});

test('shared address: forwarded requests from a trusted proxy that all resolve to the gateway -> overview flag + one webhook', async () => {
  // Container mode where Caddy itself only sees the gateway (docker-proxy): XFF = gateway, peer = trusted Caddy (here 127.0.0.1).
  const env = { APP_NETWORK_SUBNET: '172.31.80.0/24', APP_NETWORK_GATEWAY: '172.31.80.1', PROXY_MODE: 'container', CADDY_IP: '172.31.80.10' };
  const cidrs = '172.31.80.10,127.0.0.1,::1';
  const bad = await scenario(cidrs, env, () => '172.31.80.1', 25);
  assert.equal(bad.dash.proxyMisconfig.shared.tripped, true, JSON.stringify(bad.dash.proxyMisconfig));
  assert.equal(bad.dash.proxyMisconfig.count, 0);
  const flag = bad.dash.warnings.find((w) => w.key === 'proxy-shared-address');
  assert.equal(flag?.text, '疑似所有用户被识别成同一个地址，可能共用限流额度，请联系 SRE。');
  assert.ok(Date.parse(bad.dash.proxyMisconfig.shared.lastSeenAt) > Date.now() - 60_000);
  assert.equal(flag.lastSeenAt, bad.dash.proxyMisconfig.shared.lastSeenAt);
  assert.equal(bad.posts.length, 1, JSON.stringify(bad.posts));
  assert.equal(bad.posts[0].type, 'proxy-shared-address');
  // Same deployment, real client addresses: nothing.
  const good = await scenario(cidrs, env, (i) => `203.0.113.${i}`, 25);
  assert.equal(good.dash.proxyMisconfig.shared.tripped, false);
  assert.equal(good.dash.proxyMisconfig.shared.samples, 25);
  assert.ok(!good.dash.warnings.some((w) => w.key.startsWith('proxy-')));
  assert.equal(good.posts.length, 0);
});

test('host mode regression (retest 4.1d P2-1): 25 requests with XFF 127.0.0.1 from the gateway peer -> no flag, no webhook', async () => {
  // The integration client connects from 127.0.0.1, so here 127.0.0.1 plays the gateway (host mode trusts the gateway).
  const env = { APP_NETWORK_SUBNET: '127.0.0.0/8', APP_NETWORK_GATEWAY: '127.0.0.1' };
  const { dash, posts } = await scenario('127.0.0.1,::1', env, () => '127.0.0.1', 25);
  assert.equal(dash.proxyMisconfig.shared.samples, 0, JSON.stringify(dash.proxyMisconfig));
  assert.equal(dash.proxyMisconfig.shared.tripped, false);
  assert.ok(!dash.warnings.some((w) => w.key.startsWith('proxy-')));
  assert.equal(posts.length, 0);
});

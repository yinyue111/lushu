import test from 'node:test';
import assert from 'node:assert/strict';
import { createProxyMisconfigMonitor, PROXY_MISCONFIG_ALERT_TYPE } from '../../server/ops/proxyMisconfig.mjs';
import { dashboardWarnings } from '../../server/admin/dashboard.mjs';
import { raiseAlert, resetAlertThrottleForTests } from '../../server/ops/alerts.mjs';

const SNAP = /** @type {any} */ ({ values: { 'registration.mode': 'invite' }, overrides: { 'registration.mode': 'invite' } });
const req = (peer, headers = {}) => ({ socket: { remoteAddress: peer }, headers });
const trusted = new Set(['172.31.80.10', '127.0.0.1']);
function setup(overrides = {}) {
  let t = 1_000_000_000_000;
  const warns = [];
  const alerts = [];
  const m = createProxyMisconfigMonitor({
    enabled: true,
    isTrusted: (p) => trusted.has(p),
    threshold: 5,
    now: () => t,
    warn: (msg) => warns.push(msg),
    alert: (type, message) => alerts.push({ type, message }),
    ...overrides
  });
  return { m, warns, alerts, advance: (ms) => (t += ms) };
}

test('correct proxy config: trusted peer with XFF, or untrusted peer without forwarded headers, counts nothing', () => {
  const { m, warns, alerts } = setup();
  for (let i = 0; i < 100; i++) {
    m.observe(req('172.31.80.10', { 'x-forwarded-for': '203.0.113.9' }));
    m.observe(req('172.31.80.1', {}));
  }
  assert.equal(m.state().count, 0);
  assert.equal(m.state().tripped, false);
  assert.deepEqual(warns, []);
  assert.deepEqual(alerts, []);
  assert.deepEqual(
    dashboardWarnings(SNAP, {}, m.state()).filter((w) => w.key === 'proxy-misconfig'),
    []
  );
});

test('disabled (TRUST_PROXY_HEADERS off) never counts', () => {
  const { m } = setup({ enabled: false });
  m.observe(req('172.31.80.4', { 'x-forwarded-for': '1.2.3.4' }));
  assert.equal(m.state().count, 0);
});

test('misconfig: warn once (then rate-limited), overview flag over threshold, alert once per hour, rolling window', () => {
  const { m, warns, alerts, advance } = setup();
  for (let i = 0; i < 4; i++) m.observe(req('172.31.80.4', { 'x-forwarded-for': `198.51.100.${i}` }));
  assert.equal(warns.length, 1);
  assert.match(warns[0], /untrusted peer 172\.31\.80\.4/);
  assert.doesNotMatch(warns[0], /198\.51\.100/, 'no client addresses in the log');
  assert.equal(m.state().tripped, false);
  assert.equal(alerts.length, 0);
  m.observe(req('172.31.80.4', { 'x-forwarded-proto': 'https' }));
  const s = m.state();
  assert.equal(s.count, 5);
  assert.equal(s.tripped, true);
  assert.equal(s.lastPeer, '172.31.80.4');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, PROXY_MISCONFIG_ALERT_TYPE);
  assert.doesNotMatch(alerts[0].message, /198\.51\.100/);
  const w = dashboardWarnings(SNAP, {}, s).find((x) => x.key === 'proxy-misconfig');
  assert.equal(w.tone, 'error');
  assert.equal(w.text, '代理配置疑似有误，所有用户可能共用限流额度，请联系 SRE。');
  assert.doesNotMatch(w.text, /X-Forwarded|XFF|CIDR/);
  assert.match(w.detail, /172\.31\.80\.4/);
  assert.equal(w.lastSeenAt, new Date(1_000_000_000_000).toISOString());
  assert.equal(w.processLocal, true);
  // More traffic within the hour: no more alerts; another warn only after the log interval.
  for (let i = 0; i < 50; i++) m.observe(req('172.31.80.4', { 'x-forwarded-for': '1.1.1.1' }));
  assert.equal(alerts.length, 1);
  assert.equal(warns.length, 1);
  advance(10 * 60_000 + 1);
  m.observe(req('172.31.80.4', { 'x-forwarded-for': '1.1.1.1' }));
  assert.equal(warns.length, 2);
  // Old buckets fell out of the 10-minute window.
  assert.equal(m.state().count, 1);
  assert.equal(m.state().tripped, false);
  // Condition still holds an hour later: one more alert.
  advance(60 * 60_000);
  for (let i = 0; i < 5; i++) m.observe(req('172.31.80.4', { 'x-forwarded-for': '1.1.1.1' }));
  assert.equal(alerts.length, 2);
});

test('webhook goes through ALERT_WEBHOOK_URL once (raiseAlert throttle)', async () => {
  resetAlertThrottleForTests();
  const prev = process.env.ALERT_WEBHOOK_URL;
  process.env.ALERT_WEBHOOK_URL = 'https://hooks.example/alert';
  const posts = [];
  const fetchImpl = /** @type {any} */ (async (url, init) => (posts.push({ url, body: JSON.parse(init.body) }), { ok: true, status: 200 }));
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    const { m, advance } = setup({ alert: (type, message) => raiseAlert(type, message, { fetchImpl }) });
    for (let i = 0; i < 30; i++) m.observe(req('172.31.80.4', { 'x-forwarded-for': '1.1.1.1' }));
    advance(5 * 60_000);
    for (let i = 0; i < 30; i++) m.observe(req('172.31.80.4', { 'x-forwarded-for': '1.1.1.1' }));
    await new Promise((r) => setImmediate(r));
    assert.equal(posts.length, 1);
    assert.equal(posts[0].body.type, 'proxy-misconfig');
    assert.equal(posts[0].url, 'https://hooks.example/alert');
  } finally {
    console.warn = origWarn;
    if (prev === undefined) delete process.env.ALERT_WEBHOOK_URL;
    else process.env.ALERT_WEBHOOK_URL = prev;
    resetAlertThrottleForTests();
  }
});

test('shared-address signal: >=90% of forwarded requests resolving to the gateway, with a minimum sample', () => {
  const resolveClient = (r) => r.resolved;
  const fwd = (resolved) => ({ ...req('172.31.80.10', { 'x-forwarded-for': resolved }), resolved });
  const { m, alerts, warns, advance } = setup({ gateway: '172.31.80.1', resolveClient, sharedMinSample: 20 });
  // Low traffic: 19 requests all from the gateway never trips.
  for (let i = 0; i < 19; i++) m.observe(fwd('172.31.80.1'));
  assert.equal(m.state().shared.tripped, false);
  assert.equal(alerts.length, 0);
  // Healthy mix (real clients) stays quiet even with many requests.
  const healthy = setup({ gateway: '172.31.80.1', resolveClient });
  for (let i = 0; i < 200; i++) healthy.m.observe(fwd(i % 20 === 0 ? '172.31.80.1' : `203.0.113.${i % 250}`));
  assert.equal(healthy.m.state().shared.tripped, false);
  assert.equal(healthy.alerts.length, 0);
  assert.equal(healthy.m.state().count, 0);
  // 20th gateway request: >= 90% of >= 20 -> tripped, one alert, overview flag.
  m.observe(fwd('::ffff:172.31.80.1'));
  const s = m.state();
  assert.equal(s.shared.tripped, true);
  assert.equal(s.shared.samples, 20);
  assert.equal(s.count, 0, 'untrusted-peer signal stays at zero');
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].message, /疑似所有用户被识别成同一个地址/);
  assert.equal(warns.length, 0);
  const w = dashboardWarnings(SNAP, {}, s).find((x) => x.key === 'proxy-shared-address');
  assert.equal(w.text, '疑似所有用户被识别成同一个地址，可能共用限流额度，请联系 SRE。');
  assert.match(w.detail, /172\.31\.80\.1/);
  assert.equal(w.lastSeenAt, s.shared.lastSeenAt);
  assert.ok(Date.parse(w.lastSeenAt) > 0);
  assert.equal(w.processLocal, true);
  // Dedup: same hourly throttle as the other signal.
  for (let i = 0; i < 50; i++) m.observe(fwd('172.31.80.1'));
  assert.equal(alerts.length, 1);
  // Window rolls over: quiet again.
  advance(11 * 60_000);
  assert.equal(m.state().shared.tripped, false);
  // 85% gateway with plenty of samples: below the 90% ratio.
  const mixed = setup({ gateway: '172.31.80.1', resolveClient });
  for (let i = 0; i < 100; i++) mixed.m.observe(fwd(i < 85 ? '172.31.80.1' : '203.0.113.7'));
  assert.equal(mixed.m.state().shared.tripped, false);
  // No gateway configured (npm start): signal off.
  const nogw = setup({ resolveClient });
  for (let i = 0; i < 50; i++) nogw.m.observe(fwd('172.31.80.1'));
  assert.equal(nogw.m.state().shared.tripped, false);
  // Requests without X-Forwarded-For (direct curl from the host) are not sampled.
  const direct = setup({ gateway: '172.31.80.1', resolveClient });
  for (let i = 0; i < 50; i++) direct.m.observe(/** @type {any} */ ({ ...req('172.31.80.1'), resolved: '172.31.80.1' }));
  assert.equal(direct.m.state().shared.samples, 0);
});

test('overview time is HH:mm in Asia/Taipei', async () => {
  const { hhmmTaipei } = await import('../../admin/src/time.js');
  assert.equal(hhmmTaipei('2026-10-13T18:05:00.000Z'), '02:05');
  assert.equal(hhmmTaipei('2026-10-14T03:59:00.000Z'), '11:59');
});

test('shared-address: host mode, on-server requests via Caddy (XFF 127.0.0.1 from the gateway) are not sampled', () => {
  // Host mode trust list: gateway + loopback. Caddy on the host forwards a loopback client as XFF 127.0.0.1.
  const hostTrusted = new Set(['172.31.80.1', '127.0.0.1', '::1']);
  const { m, alerts } = setup({ isTrusted: (p) => hostTrusted.has(p), gateway: '172.31.80.1', resolveClient: () => '172.31.80.1' });
  for (let i = 0; i < 25; i++) m.observe(req('172.31.80.1', { 'x-forwarded-for': '127.0.0.1' }));
  for (let i = 0; i < 25; i++) m.observe(req('172.31.80.1', { 'x-forwarded-for': '::1, 127.0.0.1' }));
  assert.equal(m.state().shared.samples, 0);
  assert.equal(m.state().shared.tripped, false);
  assert.equal(m.state().count, 0);
  assert.deepEqual(alerts, []);
});

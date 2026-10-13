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

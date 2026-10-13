#!/usr/bin/env node
// Post-deploy smoke test (build design §smoke). Read-only by default; nothing here changes the deployment.
//
//   node scripts/smoke-prod.mjs --base https://example.com [--commit abc1234] [--share-id <publicId>] [--generate]
//
// Checks:
//   1. GET /            → 200 and the SPA root div
//   2. GET /api/health  → ok:true and a commit (matches --commit when given)
//   3. --generate       → one fast generation (costs one model call; needs SMOKE_ACCESS_CODE when the site has one)
//   4. --share-id       → GET /api/share/<id> returns the fixture routebook
//   5. 404 for /.env, /.git/config, /.git/HEAD, a .js.map, /dist-sourcemaps/
//   6. /admin/ is NOT reachable from this machine (expected outside the gateway allowlist): 401/403/404
//      Pass --admin-reachable when running from an allowlisted host to assert the opposite.
// Exit code 1 if any check fails.
import process from 'node:process';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback = '') => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const base = option('base', process.env.SMOKE_BASE_URL || '').replace(/\/$/, '');
if (!base) {
  console.error('usage: node scripts/smoke-prod.mjs --base https://host [--commit sha] [--share-id id] [--generate] [--admin-reachable]');
  process.exit(2);
}
const expectedCommit = option('commit', process.env.SMOKE_EXPECT_COMMIT || '');
const shareId = option('share-id', process.env.SMOKE_SHARE_ID || '');
const timeout = Number(option('timeout', '15000'));

const results = [];
async function check(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail ?? '', ms: Date.now() - started });
  } catch (error) {
    results.push({ name, ok: false, detail: error.message, ms: Date.now() - started });
  }
}
const get = (path, init = {}) => fetch(`${base}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(timeout), ...init });
const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};

await check('home 200 with root div', async () => {
  const response = await get('/');
  expect(response.status === 200, `status ${response.status}`);
  expect(/<div id="root"><\/div>/.test(await response.text()), 'root div missing');
});

await check('health ok + commit', async () => {
  const response = await get('/api/health');
  const data = await response.json().catch(() => ({}));
  expect(response.status === 200 && data.ok === true, `status ${response.status} ok=${data.ok}`);
  expect(data.commit && data.commit !== 'unknown', `commit is ${data.commit ?? 'missing'} (set APP_COMMIT at build/deploy)`);
  if (expectedCommit)
    expect(
      String(expectedCommit).startsWith(data.commit) || String(data.commit).startsWith(expectedCommit),
      `commit ${data.commit} ≠ expected ${expectedCommit}`
    );
  return `commit ${data.commit}, config v${data.configVersion ?? '?'}`;
});

if (flag('generate')) {
  await check('generate (fast)', async () => {
    const headers = { 'content-type': 'application/json' };
    if (process.env.SMOKE_ACCESS_CODE) headers['x-routebook-token'] = process.env.SMOKE_ACCESS_CODE;
    const response = await fetch(`${base}/api/generate-routebook`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(Math.max(timeout, 180000)),
      body: JSON.stringify({ city: process.env.SMOKE_CITY || '杭州', days: 1, mode: 'fast', guide: '冒烟测试：西湖半日' })
    });
    const data = await response.json().catch(() => ({}));
    expect(response.status === 200, `status ${response.status} ${data.code ?? ''}`);
    const routebook = data.routebook ?? data;
    expect(Array.isArray(routebook.stops) && routebook.stops.length > 0, 'no stops in result');
    return `${routebook.stops.length} stops`;
  });
}

if (shareId) {
  await check('share fixture', async () => {
    const response = await get(`/api/share/${encodeURIComponent(shareId)}`);
    const data = await response.json().catch(() => ({}));
    expect(response.status === 200, `status ${response.status}`);
    const routebook = data.routebook ?? data;
    expect(Array.isArray(routebook.stops), 'share response has no stops');
    return routebook.title ?? '';
  });
}

for (const path of ['/.env', '/.git/config', '/.git/HEAD', '/assets/index.js.map', '/dist-sourcemaps/']) {
  await check(`404 ${path}`, async () => {
    const response = await get(path);
    const text = await response.text();
    const leaked = /^[A-Z_]+=|\[core\]|^ref: refs\//m.test(text) || /"mappings"\s*:/.test(text);
    expect(!leaked, `${path} leaked content`);
    expect(response.status === 404, `status ${response.status} (expected 404)`);
  });
}

await check(flag('admin-reachable') ? '/admin reachable (allowlisted host)' : '/admin blocked outside allowlist', async () => {
  const response = await get('/admin/');
  if (flag('admin-reachable')) expect(response.status === 200, `status ${response.status}`);
  else expect([401, 403, 404].includes(response.status), `status ${response.status}: the console must not be public`);
  const api = await get('/api/admin/me');
  if (!flag('admin-reachable')) expect([401, 403, 404].includes(api.status), `/api/admin/me status ${api.status}`);
  return `status ${response.status}`;
});

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ` — ${r.detail}` : ''} (${r.ms}ms)`);
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ADMIN_TOKEN, API_TOKEN, PROJECT_ROOT, adminHeaders, fetchJson, jsonHeaders, startServer, waitForExit, writeJsonl } from '../helpers/server.mjs';

const HAS_DIST = existsSync(join(PROJECT_ROOT, 'dist', 'index.html'));

test('production refuses the OSM basemap without TIANDITU_KEY / AMAP_TILE_KEY', async () => {
  const server = await startServer({ waitFor: 'none', env: { ALLOW_OSM_BASEMAP_IN_PRODUCTION: null } });
  try {
    const { code } = await waitForExit(server);
    assert.notEqual(code, 0);
    assert.match(server.output.join(''), /not approved for production/);
  } finally {
    await server.stop();
  }
});

test('M3: invalid numeric env values fall back to defaults instead of blocking requests', async () => {
  const server = await startServer({ env: { RATE_LIMIT_MAX: 'abc', MAX_JSON_BODY_BYTES: '' } });
  try {
    const result = await fetchJson(`${server.baseUrl}/api/import-guide`, {
      method: 'POST',
      headers: jsonHeaders({ 'x-routebook-token': API_TOKEN }),
      body: JSON.stringify({ urls: ['http://127.0.0.1:1/private'] })
    });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    // The guide text users see shows the import status in Chinese, never the raw enum.
    assert.match(result.data.guideText, /｜抓取失败/);
    assert.doesNotMatch(result.data.guideText, /｜failed/);
    assert.match(server.output.join(''), /RATE_LIMIT_MAX="abc" is not a valid integer/);
  } finally {
    await server.stop();
  }
});

test('M2: production refuses local bypass on a non-loopback HOST', async () => {
  const server = await startServer({
    waitFor: 'none',
    env: { HOST: '0.0.0.0', ALLOW_LOCAL_ADMIN_BYPASS: 'true', REQUIRE_LOCAL_ADMIN_TOKEN: null }
  });
  try {
    const { code } = await waitForExit(server);
    assert.notEqual(code, 0);
    assert.match(server.output.join(''), /Refusing to start in production/);
  } finally {
    await server.stop();
  }
});

test('M2: legacy PROFILE_ID_SECRET fallback keeps tokens valid and the documented migration preserves them', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'routebook-secret-'));
  // Old deployment: no PROFILE_ID_SECRET, admin token reused as HMAC secret.
  const legacy = await startServer({ dataDir, env: { PROFILE_ID_SECRET: null } });
  let profile;
  try {
    assert.match(legacy.output.join(''), /DEPRECATED: PROFILE_ID_SECRET is not set/);
    const created = await fetchJson(`${legacy.baseUrl}/api/profile`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ homeCity: '杭州' })
    });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    profile = created.data.profile;
    assert.ok(profile.id && profile.profileAccessToken);
  } finally {
    await legacy.stop();
  }
  const ownerHeaders = { 'x-routebook-profile-id': profile.id, 'x-routebook-profile-token': profile.profileAccessToken };
  // Migration: PROFILE_ID_SECRET explicitly set to the old admin token value.
  const migrated = await startServer({ dataDir, env: { PROFILE_ID_SECRET: ADMIN_TOKEN, ROUTEBOOK_ADMIN_TOKEN: 'rotated-admin-token' } });
  try {
    assert.doesNotMatch(migrated.output.join(''), /DEPRECATED/);
    const read = await fetchJson(`${migrated.baseUrl}/api/checkins?profileId=${profile.id}`, { headers: ownerHeaders });
    assert.equal(read.status, 200, JSON.stringify(read.data));
  } finally {
    await migrated.stop();
  }
  // Counter-check: a different secret would invalidate the stored hash.
  const wrong = await startServer({ dataDir, env: { PROFILE_ID_SECRET: 'some-new-secret' } });
  try {
    const read = await fetchJson(`${wrong.baseUrl}/api/checkins?profileId=${profile.id}`, { headers: ownerHeaders });
    assert.equal(read.status, 403);
  } finally {
    await wrong.stop();
  }
});

test('H6: production ignores ~/.codex unless AI_RUNTIME_FROM_CODEX=true and explains not-ready', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'routebook-codex-'));
  await writeFile(join(codexHome, 'config.toml'), 'model_provider = "yinyue"\n[model_providers.yinyue]\nbase_url = "http://127.0.0.1:9/v1"\n');
  await writeFile(join(codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'codex-file-key' }));
  const env = {
    OPENAI_BASE_URL: null,
    OPENAI_API_KEY: null,
    AI_PROVIDER: null,
    CODEX_HOME: codexHome,
    CODEX_CONFIG_PATH: join(codexHome, 'config.toml'),
    CODEX_AUTH_PATH: join(codexHome, 'auth.json')
  };
  const strict = await startServer({ env });
  try {
    const health = await fetchJson(`${strict.baseUrl}/api/health`, { headers: adminHeaders() });
    assert.equal(health.data.ready, false);
    assert.match(health.data.reason, /OPENAI_API_KEY 未配置/);
  } finally {
    await strict.stop();
  }
  const optedIn = await startServer({ env: { ...env, AI_RUNTIME_FROM_CODEX: 'true' } });
  try {
    const health = await fetchJson(`${optedIn.baseUrl}/api/health`, { headers: adminHeaders() });
    assert.equal(health.data.ready, true, JSON.stringify(health.data));
  } finally {
    await optedIn.stop();
  }
});

test('L3: production does not drift to another port when PORT is busy', async () => {
  const first = await startServer();
  const second = await startServer({ port: first.port, waitFor: 'none' });
  try {
    const { code } = await waitForExit(second);
    assert.equal(code, 1);
    assert.match(second.output.join(''), /already in use/);
  } finally {
    await second.stop();
    await first.stop();
  }
});

test('L3: SIGTERM shuts the server down gracefully with exit code 0', async () => {
  const server = await startServer();
  server.child.kill('SIGTERM');
  const { code } = await waitForExit(server);
  assert.equal(code, 0);
  assert.match(server.output.join(''), /SIGTERM received, shutting down/);
  await server.stop();
});

test('L6: routebook edit-token checks still accept the right token and reject others', async () => {
  const server = await startServer();
  try {
    const created = await fetchJson(`${server.baseUrl}/api/routebooks`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        title: '编辑令牌测试',
        city: '杭州',
        stops: [
          { name: '柳浪闻莺', day: 1 },
          { name: '南宋御街', day: 1 }
        ]
      })
    });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    const { publicId, editToken, version } = created.data.routebook;
    assert.ok(editToken);
    const wrong = await fetchJson(`${server.baseUrl}/api/routebooks`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ ...created.data.routebook, editToken: `${editToken.slice(0, -1)}x`, expectedVersion: version })
    });
    assert.equal(wrong.status, 403);
    const right = await fetchJson(`${server.baseUrl}/api/routebooks`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ ...created.data.routebook, title: '改名', editToken, expectedVersion: version })
    });
    assert.equal(right.status, 200, JSON.stringify(right.data));
    assert.equal(right.data.routebook.publicId, publicId);
  } finally {
    await server.stop();
  }
});

test('L9: public read endpoints are rate limited', async () => {
  const server = await startServer({ env: { RATE_LIMIT_PUBLIC_READ_MAX: '2', RATE_LIMIT_PUBLIC_CONFIG_MAX: '2' } });
  try {
    // public-read bucket (expensive JSONL reads) and public-config bucket (cheap config) are separate.
    for (const [first, then] of [
      ['/api/poi-knowledge', '/api/routebooks?status=published'],
      ['/api/cms', '/api/products']
    ]) {
      const statuses = [];
      for (let index = 0; index < 2; index += 1) statuses.push((await fetch(`${server.baseUrl}${first}`)).status);
      statuses.push((await fetch(`${server.baseUrl}${then}`)).status);
      assert.deepEqual(statuses, [200, 200, 429], `${first} then ${then}`);
    }
  } finally {
    await server.stop();
  }
});

test('ops GET listings share an ops-read rate-limit bucket (checked before admin auth)', async () => {
  const server = await startServer({ env: { RATE_LIMIT_OPS_READ_MAX: '2' } });
  try {
    const statuses = [];
    for (const path of ['/api/ops/review-queue', '/api/ops/audits', '/api/ops/checkins', '/api/ops/imports']) {
      statuses.push((await fetch(`${server.baseUrl}${path}`, { headers: adminHeaders() })).status);
    }
    assert.deepEqual(statuses, [200, 200, 429, 429]);
    // Unauthenticated guesses consume the same budget instead of reaching token comparison.
    assert.equal((await fetch(`${server.baseUrl}/api/ops/audits`)).status, 429);
    // Other buckets are unaffected.
    assert.equal((await fetch(`${server.baseUrl}/api/cities`)).status, 200);
  } finally {
    await server.stop();
  }
});

async function seedPublishedRoutebook(dataDir) {
  await mkdir(dataDir, { recursive: true });
  await writeJsonl(dataDir, 'routebooks.jsonl', [
    {
      id: 'og-test',
      publicId: 'og-test',
      title: '分享测试',
      city: '杭州',
      publishStatus: 'published',
      version: 1,
      stops: []
    }
  ]);
}

test('L4: og:image ignores a spoofed Host header and uses PUBLIC_BASE_URL when set', { skip: !HAS_DIST && 'requires npm run build' }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'routebook-og-'));
  await seedPublishedRoutebook(dataDir);
  const server = await startServer({ dataDir });
  try {
    const { request } = await import('node:http');
    const html = await new Promise((resolve, reject) => {
      const req = request(`${server.baseUrl}/share/og-test`, { headers: { host: 'evil.example/"><script>x</script>' } }, (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve(body));
      });
      req.on('error', reject);
      req.end();
    });
    assert.match(html, /og:title" content="分享测试/);
    assert.doesNotMatch(html, /evil\.example/);
    const spoofedProto = await fetch(`${server.baseUrl}/share/og-test`, { headers: { 'x-forwarded-proto': 'javascript' } }).then((r) => r.text());
    assert.match(spoofedProto, /og:image" content="http:\/\/127\.0\.0\.1:\d+\/assets\//);
  } finally {
    await server.stop();
  }
  const configured = await startServer({ dataDir, env: { PUBLIC_BASE_URL: 'https://routebook.example/' } });
  try {
    const html = await fetch(`${configured.baseUrl}/share/og-test`).then((r) => r.text());
    assert.match(html, /og:image" content="https:\/\/routebook\.example\/assets\//);
    // Site-wide default share tags must not precede (and win over) the routebook's own tags.
    assert.equal((html.match(/property="og:image"/g) ?? []).length, 1);
    assert.equal((html.match(/name="description"/g) ?? []).length, 1);
    assert.equal((html.match(/property="og:site_name"/g) ?? []).length, 1);
  } finally {
    await configured.stop();
  }
});

test('admin headers helper uses configured token', () => {
  assert.equal(adminHeaders()['x-routebook-admin-token'], ADMIN_TOKEN);
});

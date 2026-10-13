// /admin/* is served from dist-admin/ only when ADMIN_ENABLED=true, with no-store HTML, noindex and a
// self-only CSP; with the flag off both the static console and /api/admin are 404.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT, startServer } from '../helpers/server.mjs';

const built = existsSync(join(PROJECT_ROOT, 'dist-admin', 'index.html'));

test('admin console is not served when ADMIN_ENABLED is off', async () => {
  const server = await startServer({ env: { ADMIN_ENABLED: 'false' } });
  try {
    for (const path of ['/admin', '/admin/', '/admin/config'])
      assert.equal((await fetch(`${server.baseUrl}${path}`, { redirect: 'manual' })).status, 404, path);
    assert.equal((await fetch(`${server.baseUrl}/api/admin/me`)).status, 404);
  } finally {
    await server.stop();
  }
});

test('admin console static files and headers when enabled', { skip: built ? false : 'dist-admin not built (npm run build)' }, async () => {
  const server = await startServer({ env: { ADMIN_ENABLED: 'true', CONFIG_ENC_KEY: 'unit-test-config-enc-key-0123456789' } });
  try {
    const redirect = await fetch(`${server.baseUrl}/admin`, { redirect: 'manual' });
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.get('location'), '/admin/');
    for (const path of ['/admin/', '/admin/corrections']) {
      const response = await fetch(`${server.baseUrl}${path}`);
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
      assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/);
      assert.match(await response.text(), /id="admin-root"/);
    }
    assert.equal((await fetch(`${server.baseUrl}/admin/assets/nope.js`)).status, 404);
    assert.equal((await fetch(`${server.baseUrl}/admin/assets/index.js.map`)).status, 404);
    // The user app never links the console.
    assert.doesNotMatch(await (await fetch(`${server.baseUrl}/`)).text(), /\/admin\//);
  } finally {
    await server.stop();
  }
});

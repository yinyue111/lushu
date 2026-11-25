// E2E verification for offline / failed logout, local storage + SW cache wipe,
// accurate signed-in UI state while server cookie remains active, delayed retry on reload/online,
// 401 settlement, and re-login cancellation.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { authEnv, createClient } from '../test/helpers/accounts.mjs';
import { startServer } from '../test/helpers/server.mjs';
import { OFFLINE_LOGOUT_TEXT, PENDING_LOGOUT_KEY } from '../src/lib/account.js';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const requireFrom = [PROJECT_ROOT, process.env.E2E_TOOLS_DIR].filter(Boolean).map((dir) => createRequire(join(dir, 'package.json')));
const load = (name) => {
  for (const r of requireFrom) {
    try {
      return r(name);
    } catch {
      /* next */
    }
  }
  throw new Error(`${name} not found: npm i -D ${name}, or set E2E_TOOLS_DIR`);
};
const { chromium } = load('playwright');

let server;
let browser;
let baseUrl;

test.before(async () => {
  server = await startServer({ env: authEnv('login') });
  baseUrl = server.baseUrl.replace('127.0.0.1', 'localhost');
  browser = await chromium.launch();
});

test.after(async () => {
  await browser?.close();
  await server?.stop();
});

async function openSignedInMyAccount(phone, password = 'e2e-password-123') {
  const client = createClient(server.baseUrl);
  const reg = await client.register(phone, password);
  assert.equal(reg.status, 200);
  const me = await client.request('/api/auth/me');
  assert.ok(me.data?.account?.profileId);
  const account = me.data.account;

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai'
  });
  const eq = client.cookie.indexOf('=');
  await context.addCookies([
    {
      name: client.cookie.slice(0, eq),
      value: client.cookie.slice(eq + 1),
      domain: 'localhost',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'Lax'
    }
  ]);
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${baseUrl}/my#account`);
  await page.getByText('已登录', { exact: true }).waitFor();
  await page.waitForFunction((pid) => {
    try {
      return JSON.parse(localStorage.getItem('trusted-routebook:profile:v1') || '{}').id === pid;
    } catch {
      return false;
    }
  }, account.profileId);
  return { context, page, client, account, pageErrors };
}

test('offline logout wipes local routebooks/cache, keeps signed-in UI, holds signed-in during delayed reload retry, then signs out', async () => {
  const { context, page, client, account, pageErrors } = await openSignedInMyAccount('13800009101');
  try {
    // Verify MyPage tab heights: 40px on desktop (1280px), 44px on mobile (390px and 360px).
    const tabTrigger = page.getByRole('tab', { name: '账号' });
    assert.equal(Math.round((await tabTrigger.boundingBox()).height), 40);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(Math.round((await tabTrigger.boundingBox()).height), 44);
    await page.setViewportSize({ width: 360, height: 780 });
    assert.equal(Math.round((await tabTrigger.boundingBox()).height), 44);
    await page.setViewportSize({ width: 1280, height: 900 });

    // Seed local routebook + favorite + SW routebook cache for the signed-in profile.
    await page.evaluate(async (profileId) => {
      const book = {
        id: 'rb-offline-1',
        publicId: 'rb-offline-1',
        profileId,
        city: '杭州',
        title: '离线退出测试路书',
        stops: [{ id: 's1', name: '断桥残雪' }]
      };
      localStorage.setItem('trusted-routebook:routebooks', JSON.stringify([book]));
      localStorage.setItem(`trusted-routebook:favorites:${profileId}`, JSON.stringify([{ routeId: 'rb-offline-1', profileId }]));
      await caches.open('trusted-routebook-pwa-routebook-data-v1').then((cache) => cache.put('/api/routebooks/rb-offline-1', new Response('{}')));
    }, account.profileId);

    // Abort /api/auth/logout to simulate offline failure when clicking 退出登录.
    await page.route('**/api/auth/logout', (route) => route.abort('internetdisconnected'));
    await page.getByRole('button', { name: '退出登录' }).click();

    // Exact offline logout toast, local data + SW cache wiped, yet UI still truthfully shows 已登录.
    await page.getByText(OFFLINE_LOGOUT_TEXT, { exact: true }).waitFor();
    await page.getByText('已登录', { exact: true }).waitFor();
    assert.equal(await page.locator('#account-guest-title').count(), 0);

    const afterFailedState = await page.evaluate(
      async ({ profileId, pendingKey }) => ({
        books: JSON.parse(localStorage.getItem('trusted-routebook:routebooks') || '[]'),
        favorites: localStorage.getItem(`trusted-routebook:favorites:${profileId}`),
        currentProfile: JSON.parse(localStorage.getItem('trusted-routebook:profile:v1') || '{}'),
        pending: JSON.parse(localStorage.getItem(pendingKey) || 'null'),
        hasSwCache: await caches.has('trusted-routebook-pwa-routebook-data-v1')
      }),
      { profileId: account.profileId, pendingKey: PENDING_LOGOUT_KEY }
    );
    assert.equal(afterFailedState.books.length, 0);
    assert.equal(afterFailedState.favorites, null);
    assert.notEqual(afterFailedState.currentProfile.id, account.profileId);
    assert.equal(Boolean(afterFailedState.currentProfile.accountUserId), false);
    assert.equal(afterFailedState.pending?.everywhere, false);
    assert.equal(afterFailedState.hasSwCache, false);

    // Hold the retried /api/auth/logout request on reload so we can observe in-flight UI state.
    await page.unroute('**/api/auth/logout');
    let notifyRetryStarted;
    let releaseRetry;
    const retryStarted = new Promise((resolve) => {
      notifyRetryStarted = resolve;
    });
    const retryGate = new Promise((resolve) => {
      releaseRetry = resolve;
    });
    await page.route('**/api/auth/logout', async (route) => {
      notifyRetryStarted();
      await retryGate;
      await route.continue();
    });

    await page.reload();
    await retryStarted;

    // While retry is in-flight, UI MUST still show signed-in and MUST NOT re-attach account profile to device.
    await page.getByText('已登录', { exact: true }).waitFor();
    const midFlight = await page.evaluate(
      ({ pendingKey }) => ({
        pending: localStorage.getItem(pendingKey),
        profile: JSON.parse(localStorage.getItem('trusted-routebook:profile:v1') || '{}')
      }),
      { pendingKey: PENDING_LOGOUT_KEY }
    );
    assert.ok(midFlight.pending);
    assert.notEqual(midFlight.profile.id, account.profileId);

    // Release /api/auth/logout -> server revokes session, UI transitions to signed-out + shows 已退出登录.
    releaseRetry();
    await page.getByText('已退出登录', { exact: true }).waitFor();
    await page.locator('#account-guest-title').waitFor();
    assert.equal(await page.getByText('已登录', { exact: true }).count(), 0);
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), PENDING_LOGOUT_KEY), null);
    assert.equal((await client.request('/api/auth/me')).data.account, null);
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});

test('server 503 logout queues pending retry, 401 on retry settles as signed out, and re-login cancels pending logout', async () => {
  const { context, page, pageErrors } = await openSignedInMyAccount('13800009102');
  try {
    let statusToReturn = 503;
    await page.route('**/api/auth/logout', (route) =>
      route.fulfill({
        status: statusToReturn,
        contentType: 'application/json',
        body: JSON.stringify(statusToReturn === 401 ? { code: 'LOGIN_REQUIRED', error: '请先登录' } : { code: 'UPSTREAM_DOWN', error: '服务繁忙' })
      })
    );

    await page.getByRole('button', { name: '退出登录' }).click();
    await page.getByText(OFFLINE_LOGOUT_TEXT, { exact: true }).waitFor();
    await page.getByText('已登录', { exact: true }).waitFor();
    assert.ok(await page.evaluate((key) => localStorage.getItem(key), PENDING_LOGOUT_KEY));

    // Switch /api/auth/logout to return 401 and fire reconnect -> treated as settled without popping LoginSheet.
    statusToReturn = 401;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.getByText('已退出登录', { exact: true }).waitFor();
    await page.locator('#account-guest-title').waitFor();
    assert.equal(await page.getByText('已登录', { exact: true }).count(), 0);
    assert.equal(await page.getByLabel('邮箱或手机号').count(), 0);
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), PENDING_LOGOUT_KEY), null);

    // Seed a pending logout marker, then sign back in through the UI -> marker is cancelled.
    await page.unroute('**/api/auth/logout');
    await page.evaluate((key) => localStorage.setItem(key, JSON.stringify({ everywhere: true, at: Date.now() })), PENDING_LOGOUT_KEY);
    await page.locator('section[aria-labelledby="account-guest-title"]').getByRole('button', { name: '登录', exact: true }).click();
    await page.getByLabel('邮箱或手机号').fill('13800009102');
    await page.getByLabel('密码', { exact: true }).fill('e2e-password-123');
    await page.locator('form').getByRole('button', { name: '登录', exact: true }).click();

    await page.getByText('已登录', { exact: true }).waitFor();
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), PENDING_LOGOUT_KEY), null);
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});

// Modal close (X / Esc / Back button across 360 & 1280) + in-app back navigation E2E (release-v7 §2.3 & §10):
// 26 checks total (18 modal close + focus restoration checks across PoiDetail, SharePreview, LoginSheet × 360/1280 × X/Esc/Back + 8 navigation & dialog back checks).
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../test/helpers/server.mjs';
import { authEnv, createClient } from '../test/helpers/accounts.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(join(PROJECT_ROOT, 'package.json'));
const { chromium } = require('playwright');

const dataDir = mkdtempSync(join(tmpdir(), 'back-e2e-'));
const server = await startServer({ dataDir, env: authEnv('login', { ENRICH_ENABLED: 'false' }) });
const BASE = server.baseUrl.replace('127.0.0.1', 'localhost');
const browser = await chromium.launch();
let passed = 0;

async function activeFocusTagAndLabel(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    return {
      tag: el?.tagName?.toLowerCase() || '',
      ariaLabel: el?.getAttribute('aria-label') || '',
      text: (el?.textContent || '').trim().slice(0, 40)
    };
  });
}

async function closeOverlay(page, method) {
  if (method === 'x') {
    await page.getByRole('button', { name: '关闭' }).first().click();
  } else if (method === 'esc') {
    await page.keyboard.press('Escape');
  } else if (method === 'back') {
    await page.goBack();
  }
  await page.waitForTimeout(120);
}

try {
  // Part A: 3 panels (PoiDetail, SharePreview, LoginSheet) × 2 viewports (360, 1280) × 3 close methods (x, esc, back) = 18 checks
  for (const width of [360, 1280]) {
    const context = await browser.newContext({
      viewport: { width, height: width < 600 ? 844 : 900 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      isMobile: width < 600,
      hasTouch: width < 600
    });
    const page = await context.newPage();

    // 1) PoiDetail × {x, esc, back}
    await page.goto(`${BASE}/route/hangzhou-westlake-tea`);
    await page.locator('[data-stop-card]').first().waitFor();
    for (const method of ['x', 'esc', 'back']) {
      const btn = page.getByRole('button', { name: '查看柳浪闻莺详情' });
      await btn.click();
      await page.getByRole('dialog').first().waitFor();
      await closeOverlay(page, method);
      assert.equal(await page.getByRole('dialog').count(), 0, `PoiDetail ${width}px ${method} should close`);
      assert.match(page.url(), /\/route\/hangzhou-westlake-tea$/, `PoiDetail ${width}px ${method} must stay on route URL`);
      const focus = await activeFocusTagAndLabel(page);
      assert.notEqual(focus.tag, 'body', `PoiDetail ${width}px ${method} focus must not drop to body`);
      assert.equal(focus.ariaLabel, '查看柳浪闻莺详情', `PoiDetail ${width}px ${method} focus should return to trigger`);
      passed += 1;
    }

    // 2) SharePreview × {x, esc, back}
    for (const method of ['x', 'esc', 'back']) {
      if (width < 1024) {
        await page.getByRole('button', { name: '分享' }).first().click();
      } else {
        await page.getByRole('button', { name: '更多操作' }).first().click();
        await page.getByRole('menuitem', { name: '分享给朋友' }).click();
      }
      await page.getByRole('dialog').first().waitFor();
      await closeOverlay(page, method);
      assert.equal(await page.getByRole('dialog').count(), 0, `SharePreview ${width}px ${method} should close`);
      assert.match(page.url(), /\/route\/hangzhou-westlake-tea$/, `SharePreview ${width}px ${method} must stay on route URL`);
      const focus = await activeFocusTagAndLabel(page);
      assert.notEqual(focus.tag, 'body', `SharePreview ${width}px ${method} focus must not drop to body`);
      passed += 1;
    }

    // 3) LoginSheet × {x, esc, back}
    await page.goto(`${BASE}/my`);
    await page.getByRole('button', { name: '登录' }).first().waitFor();
    for (const method of ['x', 'esc', 'back']) {
      await page.getByRole('button', { name: '登录' }).first().click();
      await page.getByRole('dialog').first().waitFor();
      await closeOverlay(page, method);
      assert.equal(await page.getByRole('dialog').count(), 0, `LoginSheet ${width}px ${method} should close`);
      assert.match(page.url(), /\/my$/, `LoginSheet ${width}px ${method} must stay on /my`);
      const focus = await activeFocusTagAndLabel(page);
      assert.notEqual(focus.tag, 'body', `LoginSheet ${width}px ${method} focus must not drop to body`);
      assert.equal(focus.text, '登录', `LoginSheet ${width}px ${method} focus should return to 登录 button`);
      passed += 1;
    }

    await context.close();
  }

  // Part B: 8 navigation & secondary dialog back-button checks = 26 total
  const client = createClient(server.baseUrl);
  const reg = await client.register('13800005202', 'back-e2e-pass-123');
  assert.equal(reg.status, 200);
  const seedRes = await fetch(`${server.baseUrl}/api/routebooks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: client.cookie, origin: server.baseUrl },
    body: JSON.stringify({
      id: 'back-owned-rb',
      publicId: 'back-owned-rb',
      profileId: reg.data.account.profileId,
      city: '杭州',
      title: '返回键测试路书',
      days: ['Day 1', 'Day 2'],
      stops: [
        { id: 's1', day: 'Day 1', time: '09:30', name: '柳浪闻莺', lat: 30.242, lng: 120.1617 },
        { id: 's2', day: 'Day 1', time: '11:30', name: '南宋御街', lat: 30.2432, lng: 120.1696 },
        { id: 's3', day: 'Day 2', time: '10:00', name: '法喜寺', lat: 30.2366, lng: 120.0954 }
      ]
    })
  });
  assert.equal(seedRes.status, 200);

  const navCtx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
  const eq = client.cookie.indexOf('=');
  await navCtx.addCookies([
    { name: client.cookie.slice(0, eq), value: client.cookie.slice(eq + 1), domain: 'localhost', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }
  ]);
  const navPage = await navCtx.newPage();

  // 19 & 20: Home -> Destination -> Route -> browser Back -> Destination -> browser Back -> Home
  await navPage.goto(`${BASE}/`);
  await navPage.goto(`${BASE}/destination/${encodeURIComponent('杭州')}`);
  await navPage
    .getByRole('button', { name: /看路书/ })
    .first()
    .click();
  await navPage.waitForURL(/\/route\/hangzhou-westlake-tea$/);
  await navPage.goBack();
  await navPage.waitForURL(/\/destination\//);
  passed += 1;

  await navPage
    .getByRole('button', { name: /看路书/ })
    .first()
    .click();
  await navPage.waitForURL(/\/route\/hangzhou-westlake-tea$/);
  await navPage.getByRole('button', { name: '返回' }).first().click();
  await navPage.waitForURL(/\/destination\//);
  passed += 1;

  // 21 & 22: Direct entry /route/back-owned-rb -> DayActionsMenu ConfirmDialog back-close + StopEditor back/esc close
  await navPage.goto(`${BASE}/route/back-owned-rb`);
  await navPage.getByRole('button', { name: '第 1 天的更多操作' }).waitFor();
  await navPage.getByRole('button', { name: '第 1 天的更多操作' }).click();
  await navPage.getByRole('menuitem', { name: '删除这一天' }).click();
  await navPage.getByRole('alertdialog').waitFor();
  await navPage.goBack();
  await navPage.waitForTimeout(100);
  assert.equal(await navPage.getByRole('alertdialog').count(), 0, 'ConfirmDialog should close on Back');
  assert.match(navPage.url(), /\/route\/back-owned-rb$/);
  passed += 1;

  await navPage.getByRole('button', { name: '加一站' }).click();
  await navPage.getByRole('dialog').waitFor();
  // Verify StopEditor folds coordinates into 高级 (§2.6)
  assert.equal(await navPage.getByLabel('纬度').isVisible(), false, 'latitude should be tucked inside collapsed 高级');
  await navPage.getByText(/高级/).click();
  assert.equal(await navPage.getByLabel('纬度').isVisible(), true, 'latitude visible when 高级 expanded');
  await navPage.keyboard.press('Escape');
  await navPage.waitForTimeout(100);
  assert.equal(await navPage.getByRole('dialog').count(), 0, 'StopEditor closes on Esc');
  passed += 1;

  // 23: AdjustChatSheet closes on Back without leaving route
  await navPage.getByRole('button', { name: '用一句话改' }).click();
  await navPage.getByRole('dialog').waitFor();
  await navPage.goBack();
  await navPage.waitForTimeout(100);
  assert.equal(await navPage.getByRole('dialog').count(), 0, 'AdjustChatSheet closes on Back');
  assert.match(navPage.url(), /\/route\/back-owned-rb$/);
  passed += 1;

  // 24: Direct entry /route/back-owned-rb -> in-app 返回 button goes to /
  await navPage.goto(`${BASE}/route/back-owned-rb`);
  await navPage.getByRole('button', { name: '返回' }).first().waitFor();
  await navPage.getByRole('button', { name: '返回' }).first().click();
  await navPage.waitForURL(`${BASE}/`);
  passed += 1;

  // 25 & 26: Home -> My -> Builder -> Back -> My -> Back -> Home
  await navPage.getByRole('button', { name: /我的/ }).first().click();
  await navPage.waitForURL(`${BASE}/my`);
  await navPage.getByRole('button', { name: '新建路书' }).click();
  await navPage.waitForURL(`${BASE}/builder`);
  await navPage.goBack();
  await navPage.waitForURL(`${BASE}/my`);
  passed += 1;
  await navPage.goBack();
  await navPage.waitForURL(`${BASE}/`);
  passed += 1;

  await navCtx.close();
  assert.equal(passed, 26);
  console.log(`back e2e: ${passed}/26 passed`);
} finally {
  await browser.close();
  await server.stop();
}

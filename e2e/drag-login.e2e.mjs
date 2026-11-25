// Guest copy + 401 login cancel + mobile touch drag-to-reorder E2E (release-v7 §2.6 & §10):
// Runs across 360px and 390px mobile touch viewports (3 checks × 2 widths = 6/6).
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../test/helpers/server.mjs';
import { authEnv } from '../test/helpers/accounts.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(join(PROJECT_ROOT, 'package.json'));
const { chromium } = require('playwright');

const dataDir = mkdtempSync(join(tmpdir(), 'drag-login-e2e-'));
const server = await startServer({ dataDir, env: authEnv('login', { ENRICH_ENABLED: 'false' }) });
const BASE = server.baseUrl.replace('127.0.0.1', 'localhost');
const browser = await chromium.launch();
let passed = 0;

async function stopNamesOnPage(page) {
  return page
    .locator('[data-stop-card] h3')
    .allTextContents()
    .then((list) => list.map((s) => s.trim()));
}

async function runViewportSuite(width) {
  const context = await browser.newContext({
    viewport: { width, height: 844 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    isMobile: true,
    hasTouch: true
  });
  const page = await context.newPage();
  const generateCalls = [];
  page.on('request', (req) => {
    if (/\/api\/(generate-routebook|generation-jobs)/.test(req.url())) generateCalls.push(req.url());
  });

  try {
    // Check 1: On featured route, clicking 「改成我的」 triggers 401 LoginSheet from /copy (not from drag),
    // never fires generation, and stop order has NOT changed before LoginSheet opens.
    await page.goto(`${BASE}/route/hangzhou-westlake-tea`);
    await page.locator('[data-stop-card]').first().waitFor();
    const initialOrder = await stopNamesOnPage(page);
    assert.deepEqual(initialOrder, ['柳浪闻莺', '南宋御街', '北山街日落线'], `${width}px initial Day 1 stop order`);

    // Public featured route displays 公交地铁 on >1.2km leg (not 打车)
    const bodyText = await page.locator('main').innerText();
    assert.match(bodyText, /公交地铁/, `${width}px featured route should display 公交地铁`);
    assert.equal(/打车约/.test(bodyText), false, `${width}px featured route must not display 打车约`);

    await page.getByRole('button', { name: '改成我的' }).first().click();
    const closeBtn = page.getByRole('button', { name: '关闭' }).first();
    await closeBtn.waitFor({ timeout: 10000 });
    assert.deepEqual(await stopNamesOnPage(page), initialOrder, `${width}px order must not change before/when login sheet opens`);
    assert.equal(generateCalls.length, 0, `${width}px 改成我的 must only copy, never call generation`);
    passed += 1;

    // Check 2: Cancelling login keeps original stop order before drag, and remains identical after reload.
    await closeBtn.click();
    await page.waitForTimeout(120);
    assert.match(page.url(), /\/route\/route_/, `${width}px should stay on local private draft copy`);
    assert.deepEqual(await stopNamesOnPage(page), initialOrder, `${width}px order after cancelling login`);
    await page.reload();
    await page.locator('[data-stop-card]').first().waitFor();
    assert.deepEqual(await stopNamesOnPage(page), initialOrder, `${width}px order after reload before drag`);
    passed += 1;

    // Check 3: Dragging the touch handle on the local copy reorders stops without popping login, and persists after reload.
    await page
      .locator('[data-stop-card]')
      .first()
      .evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(80);
    const firstHandle = page.locator('[data-testid^="drag-handle-"]').first();
    await firstHandle.waitFor({ state: 'visible' });
    const handleBox = await firstHandle.boundingBox();
    const secondCard = page.locator('[data-stop-card]').nth(1);
    const secondBox = await secondCard.boundingBox();
    assert.ok(handleBox && secondBox, `${width}px drag handle and second stop card must have bounding boxes`);

    const startX = handleBox.x + handleBox.width / 2;
    const startY = handleBox.y + handleBox.height / 2;
    const endY = secondBox.y + secondBox.height * 0.65;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX, (startY + endY) / 2, { steps: 6 });
    await page.mouse.move(startX, endY, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(150);

    // Login sheet must NOT pop up on local copy drag
    assert.equal(await page.getByRole('dialog').count(), 0, `${width}px dragging local copy must not open login dialog`);
    const reordered = await stopNamesOnPage(page);
    assert.deepEqual(reordered, ['南宋御街', '柳浪闻莺', '北山街日落线'], `${width}px reordered Day 1 stops`);

    await page.reload();
    await page.locator('[data-stop-card]').first().waitFor();
    assert.deepEqual(await stopNamesOnPage(page), ['南宋御街', '柳浪闻莺', '北山街日落线'], `${width}px reordered stops persist after reload`);
    passed += 1;
  } finally {
    await context.close();
  }
}

try {
  await runViewportSuite(360);
  await runViewportSuite(390);
  // Also verify drag handle is hidden on non-touch desktop (1280px)
  const desktopCtx = await browser.newContext({ viewport: { width: 1280, height: 900 }, hasTouch: false, isMobile: false });
  const desktopPage = await desktopCtx.newPage();
  await desktopPage.goto(`${BASE}/route/hangzhou-westlake-tea`);
  await desktopPage.getByRole('button', { name: '改成我的' }).first().click();
  await desktopPage.getByRole('button', { name: '关闭' }).first().click();
  await desktopPage.waitForTimeout(100);
  const visibleDesktopHandles = await desktopPage.locator('[data-testid^="drag-handle-"]:visible').count();
  assert.equal(visibleDesktopHandles, 0, 'drag handle must be hidden on non-touch desktop devices');
  await desktopCtx.close();

  assert.equal(passed, 6);
  console.log(`drag-login e2e: ${passed}/6 passed (360px + 390px, desktop handle hidden)`);
} finally {
  await browser.close();
  await server.stop();
}

// Focus restoration E2E suite (release-v7 §5 & §10): 7 checks.
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

const dataDir = mkdtempSync(join(tmpdir(), 'focus-e2e-'));
const ENV = authEnv('login', { ENRICH_ENABLED: 'false' });
const server = await startServer({ dataDir, env: ENV });
const BASE = server.baseUrl.replace('127.0.0.1', 'localhost');
const browser = await chromium.launch();
const results = [];

async function check(name, fn) {
  await fn();
  results.push(name);
}

async function activeFocusInfo(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    return {
      tag: el?.tagName?.toLowerCase() || '',
      ariaLabel: el?.getAttribute('aria-label') || '',
      text: (el?.textContent || '').trim().slice(0, 60),
      stopCard: el?.closest?.('[data-stop-card]')?.getAttribute('data-stop-card') || ''
    };
  });
}

async function seedOwnedRoute(client, profileId, id, daysStops) {
  const days = [...new Set(daysStops.map((s) => s.day))];
  const res = await fetch(`${server.baseUrl}/api/routebooks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: client.cookie, origin: server.baseUrl },
    body: JSON.stringify({
      id,
      publicId: id,
      profileId,
      city: '杭州',
      title: `焦点测试-${id}`,
      days,
      stops: daysStops.map((s, idx) => ({
        id: `s-${idx + 1}`,
        day: s.day,
        time: s.time || '09:30',
        name: s.name,
        area: '西湖',
        stay: '60 分钟',
        cost: '免费',
        lat: 30.242 + idx * 0.002,
        lng: 120.161 + idx * 0.002
      }))
    })
  });
  assert.equal(res.status, 200, `seed ${id} failed`);
}

try {
  const client = createClient(server.baseUrl);
  const reg = await client.register('13800005101', 'focus-e2e-pass-123');
  assert.equal(reg.status, 200);
  const profileId = reg.data.account.profileId;

  await seedOwnedRoute(client, profileId, 'focus-rb-3d', [
    { day: 'Day 1', name: '柳浪闻莺', time: '09:00' },
    { day: 'Day 1', name: '南宋御街', time: '11:00' },
    { day: 'Day 1', name: '北山街', time: '14:30' },
    { day: 'Day 2', name: '法喜寺', time: '09:30' },
    { day: 'Day 3', name: '龙井茶园', time: '10:00' }
  ]);
  await seedOwnedRoute(client, profileId, 'focus-rb-2d', [
    { day: 'Day 1', name: '柳浪闻莺', time: '09:30' },
    { day: 'Day 1', name: '南宋御街', time: '11:30' },
    { day: 'Day 2', name: '法喜寺', time: '10:00' }
  ]);

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai'
  });
  const eq = client.cookie.indexOf('=');
  await context.addCookies([
    { name: client.cookie.slice(0, eq), value: client.cookie.slice(eq + 1), domain: 'localhost', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }
  ]);
  const page = await context.newPage();

  // 1) Day ⋯ menu -> 删除这一天 -> Cancel -> focus returns to day ⋯ button (not body)
  await check('1. day menu delete -> cancel restores focus to ⋯ button', async () => {
    await page.goto(`${BASE}/route/focus-rb-3d`);
    const trigger = page.getByRole('button', { name: '第 1 天的更多操作' });
    await trigger.waitFor();
    await trigger.click();
    await page.getByRole('menuitem', { name: '删除这一天' }).click();
    const dialog = page.getByRole('alertdialog');
    await dialog.waitFor();
    await dialog.getByRole('button', { name: '取消' }).click();
    await dialog.waitFor({ state: 'detached' });
    await page.waitForTimeout(80);
    const info = await activeFocusInfo(page);
    assert.notEqual(info.tag, 'body', `focus dropped to body: ${JSON.stringify(info)}`);
    assert.equal(info.ariaLabel, '第 1 天的更多操作');
  });

  // 2) Day ⋯ menu -> 合并到另一天 -> Cancel -> focus returns to day ⋯ button (not body)
  await check('2. day menu merge -> cancel restores focus to ⋯ button', async () => {
    const trigger = page.getByRole('button', { name: '第 1 天的更多操作' });
    await trigger.click();
    await page.getByRole('menuitem', { name: '合并到另一天' }).click();
    const dialog = page.getByRole('alertdialog');
    await dialog.waitFor();
    await dialog.getByRole('button', { name: '取消' }).click();
    await dialog.waitFor({ state: 'detached' });
    await page.waitForTimeout(80);
    const info = await activeFocusInfo(page);
    assert.notEqual(info.tag, 'body');
    assert.equal(info.ariaLabel, '第 1 天的更多操作');
  });

  // 3) Day ⋯ menu on 3-day route -> 合并到另一天 -> Confirm (2 days remain, trigger stays mounted) -> focus returns to ⋯ button
  await check('3. day menu merge on 3-day route -> confirm restores focus to remaining day ⋯ button', async () => {
    await page.getByRole('tab', { name: /第 3 天/ }).click();
    const trigger = page.getByRole('button', { name: '第 3 天的更多操作' });
    await trigger.waitFor();
    await trigger.click();
    await page.getByRole('menuitem', { name: '合并到另一天' }).click();
    const dialog = page.getByRole('alertdialog');
    await dialog.waitFor();
    await dialog.getByRole('button', { name: '合并' }).click();
    await dialog.waitFor({ state: 'detached' });
    await page.waitForTimeout(80);
    const info = await activeFocusInfo(page);
    assert.notEqual(info.tag, 'body', `focus dropped to body after merge: ${JSON.stringify(info)}`);
    assert.match(info.ariaLabel, /天的更多操作/);
  });

  // 4) Unmounted trigger fallback: on 2-day route, deleting Day 2 reduces days to 1 so DayActionsMenu unmounts -> fallback to day heading (not body)
  await check('4. unmounted trigger falls back to day heading instead of body', async () => {
    await page.goto(`${BASE}/route/focus-rb-2d`);
    await page.getByRole('tab', { name: /第 2 天/ }).click();
    const trigger = page.getByRole('button', { name: '第 2 天的更多操作' });
    await trigger.waitFor();
    await trigger.click();
    await page.getByRole('menuitem', { name: '删除这一天' }).click();
    const dialog = page.getByRole('alertdialog');
    await dialog.waitFor();
    await dialog.getByRole('button', { name: '删除' }).click();
    await dialog.waitFor({ state: 'detached' });
    await page.waitForTimeout(80);
    const info = await activeFocusInfo(page);
    assert.notEqual(info.tag, 'body', `unmounted trigger dropped focus to body: ${JSON.stringify(info)}`);
    assert.match(info.text, /第\s*1\s*天/);
  });

  // Re-open 3-day route (now has Day 1: 3 stops [s-1, s-2, s-3], Day 2: 2 stops [s-4, s-5]; let's seed a fresh stop-delete route)
  await seedOwnedRoute(client, profileId, 'focus-rb-stops', [
    { day: 'Day 1', name: '柳浪闻莺', time: '09:00' },
    { day: 'Day 1', name: '南宋御街', time: '11:00' },
    { day: 'Day 1', name: '北山街', time: '14:30' },
    { day: 'Day 2', name: '法喜寺', time: '09:30' }
  ]);

  // 5) Delete stop with a next stop -> focus moves to next stop
  await check('5. delete first stop moves focus to next stop', async () => {
    await page.goto(`${BASE}/route/focus-rb-stops`);
    await page.getByRole('button', { name: '编辑柳浪闻莺' }).waitFor();
    await page.getByRole('button', { name: '编辑柳浪闻莺' }).click();
    await page.getByRole('menuitem', { name: '删除这一站' }).click();
    await page.waitForTimeout(100);
    const info = await activeFocusInfo(page);
    assert.notEqual(info.tag, 'body');
    assert.equal(info.stopCard, 's-2', `expected focus on next stop s-2 (南宋御街), got ${JSON.stringify(info)}`);
  });

  // 6) Delete last stop of the day (no next stop) -> focus moves to previous stop
  await check('6. delete last stop of day moves focus to previous stop', async () => {
    await page.getByRole('button', { name: '编辑北山街' }).click();
    await page.getByRole('menuitem', { name: '删除这一站' }).click();
    await page.waitForTimeout(100);
    const info = await activeFocusInfo(page);
    assert.notEqual(info.tag, 'body');
    assert.equal(info.stopCard, 's-2', `expected focus on previous stop s-2 (南宋御街), got ${JSON.stringify(info)}`);
  });

  // 7) Delete sole stop of a day (no next stop and no previous stop on that day; need >=3 total stops first) -> focus moves to day heading
  await seedOwnedRoute(client, profileId, 'focus-rb-sole', [
    { day: 'Day 1', name: '柳浪闻莺', time: '09:00' },
    { day: 'Day 1', name: '南宋御街', time: '11:00' },
    { day: 'Day 2', name: '法喜寺', time: '09:30' }
  ]);
  await check('7. delete sole stop of day moves focus to day heading', async () => {
    await page.goto(`${BASE}/route/focus-rb-sole`);
    await page.getByRole('tab', { name: /第 2 天/ }).click();
    await page.getByRole('button', { name: '编辑法喜寺' }).waitFor();
    await page.getByRole('button', { name: '编辑法喜寺' }).click();
    await page.getByRole('menuitem', { name: '删除这一站' }).click();
    await page.waitForTimeout(100);
    const info = await activeFocusInfo(page);
    assert.notEqual(info.tag, 'body', `focus dropped to body: ${JSON.stringify(info)}`);
    assert.equal(info.tag, 'h3', `expected focus on day heading h3, got ${JSON.stringify(info)}`);
    assert.match(info.text, /第\s*1\s*天/);
  });

  console.log(`focus e2e: ${results.length}/7 passed`);
} finally {
  await browser.close();
  await server.stop();
}

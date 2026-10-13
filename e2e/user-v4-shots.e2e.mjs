// User-side screenshots + axe for the v4 changes: the 细品 failure page (upstream down → 「用轻快重试」) and
// the wrong-data report flow (note → receipt → 「已反馈待复核」), desktop and mobile.
// Fake model upstream answers 503 to everything; no real model calls. Needs playwright + axe-core
// (repo deps or E2E_TOOLS_DIR). Screenshots → E2E_SCREENSHOT_DIR (default test-results/user-v4).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { startServer } from '../test/helpers/server.mjs';
import { authEnv, createClient } from '../test/helpers/accounts.mjs';
import { hermeticServerEnv } from '../scripts/lib/hermetic-env.mjs';

const PROJECT_ROOT = new URL('..', import.meta.url).pathname;
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
const axeSource = readFileSync(createRequireFirst('axe-core/axe.min.js'), 'utf8');
function createRequireFirst(spec) {
  for (const r of requireFrom) {
    try {
      return r.resolve(spec);
    } catch {
      /* next */
    }
  }
  throw new Error(`${spec} not found`);
}
const SHOTS = process.env.E2E_SCREENSHOT_DIR || join(PROJECT_ROOT, 'test-results', 'user-v4');
mkdirSync(SHOTS, { recursive: true });

const upstream = createServer((_req, res) => {
  res.writeHead(503, { 'content-type': 'application/json' });
  res.end('{"error":{"message":"unavailable (e2e fake upstream)"}}');
});
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', () => resolve(undefined)));
const ENV = authEnv('login', {
  OPENAI_BASE_URL: `http://127.0.0.1:${/** @type {any} */ (upstream.address()).port}/v1`,
  OPENAI_API_KEY: 'e2e-fake-key',
  OPENAI_WIRE_API: 'chat_completions',
  AI_MODEL_FAST: 'fast-e2e',
  AI_MODEL_DEEP: 'deep-e2e',
  AI_STREAM: 'false',
  ENRICH_ENABLED: 'false',
  // E2E_FALLBACK_ORDER=none shows the page when no automatic 轻快 attempt was made.
  ...(process.env.E2E_FALLBACK_ORDER ? { AI_MODEL_FALLBACK_ORDER: process.env.E2E_FALLBACK_ORDER } : {})
});
const VARIANT = process.env.E2E_FALLBACK_ORDER === 'none' ? '-no-auto-fallback' : '';
const dataDir = mkdtempSync(join(tmpdir(), 'user-v4-e2e-'));
const seeded = spawnSync(process.execPath, ['e2e/seed-admin-fixture.mjs'], {
  cwd: PROJECT_ROOT,
  env: hermeticServerEnv({ NODE_ENV: 'production', ROUTEBOOK_DATA_DIR: dataDir, PROFILE_ID_SECRET: 'unit-test-profile-secret', ...ENV }),
  encoding: 'utf8'
});
assert.equal(seeded.status, 0, seeded.stderr);
const server = await startServer({ dataDir, env: ENV });
const BASE = server.baseUrl.replace('127.0.0.1', 'localhost');
const browser = await chromium.launch();
const failures = [];
const axeResults = {};
const shots = [];

async function signedInPage(viewport, phone) {
  const client = createClient(server.baseUrl);
  assert.equal((await client.register(phone, 'e2e-password-123')).status, 200);
  const context = await browser.newContext({
    viewport,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    isMobile: viewport.width < 600,
    hasTouch: viewport.width < 600
  });
  const eq = client.cookie.indexOf('=');
  await context.addCookies([
    { name: client.cookie.slice(0, eq), value: client.cookie.slice(eq + 1), domain: 'localhost', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }
  ]);
  const page = await context.newPage();
  page.on('pageerror', (error) => failures.push(`pageerror: ${error.message}`));
  return page;
}
async function axe(page, name) {
  if (!(await page.evaluate(() => 'axe' in window))) await page.evaluate(axeSource);
  const violations = await page.evaluate(async () => {
    // @ts-ignore injected
    const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } });
    return r.violations.map((v) => `${v.id}×${v.nodes.length} ${v.nodes[0]?.target.join(' ')}`);
  });
  axeResults[name] = violations;
  if (violations.length) failures.push(`axe ${name}: ${violations.join('; ')}`);
}
async function shot(page, name) {
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
  shots.push(name);
}

async function deepFailure(page, label) {
  await page.goto(`${BASE}/`);
  await page.getByLabel('攻略链接或正文').fill('杭州一日：上午柳浪闻莺，中午南宋御街吃饭，下午北山街散步看宝石山。');
  await page.getByRole('button', { name: '用这篇攻略排路线' }).click();
  for (const name of ['柳浪闻莺', '南宋御街', '北山街']) {
    const box = page
      .locator('li', { has: page.getByText(name, { exact: true }) })
      .first()
      .locator('input[type=checkbox]');
    await box.waitFor();
    if (!(await box.isChecked())) await box.check();
  }
  await page.getByRole('button', { name: /下一步/ }).click();
  await page.getByText('细品', { exact: true }).click();
  await page.getByRole('button', { name: '生成路书' }).last().click();
  await page.getByRole('button', { name: '用轻快重试' }).waitFor({ timeout: 60000 });
  await page.getByText('「细品」的模型这次没响应').first().waitFor();
  await axe(page, `deep-failure${VARIANT}-${label}`);
  await shot(page, `30-deep-failure${VARIANT}-${label}`);
  if (VARIANT) return;
  // 轻快 was auto-tried and failed too: 「稍后再试」 is primary, 「用轻快重试」 secondary, real last-attempt time shown.
  const actions = page.getByRole('alert').filter({ hasText: '已经自动换「轻快」试过一次' });
  const later = actions.getByRole('button', { name: '稍后再试' });
  await later.waitFor();
  const first = await actions.getByRole('button').first().textContent();
  if (!first.includes('稍后再试')) failures.push(`${label}: first action is ${first}`);
  const time = actions.locator('time');
  const iso = await time.getAttribute('datetime');
  if (!Number.isFinite(Date.parse(iso)) || Math.abs(Date.parse(iso) - Date.now()) > 5 * 60000) failures.push(`${label}: bad failedAt ${iso}`);
  if (!/最后一次尝试：\d+月\d+日 \d{2}:\d{2}/.test(await time.textContent())) failures.push(`${label}: missing last-attempt text`);
  await shot(page, `33-deep-failure-later-${label}`);
}

async function reportFlow(page, label, factText) {
  await page.goto(`${BASE}/route/e2e-rb-c`);
  await page.getByText(/本次由备用模型生成/).waitFor();
  const fact = page.locator('li', { hasText: factText }).last();
  await fact.getByText(factText).first().click();
  await fact.getByRole('button', { name: '这条不对，报告有误' }).click();
  await fact.getByLabel(/哪里不对/).fill('E2E：现场看到的不一样');
  await shot(page, `31-report-note-${label}`);
  await fact.getByRole('button', { name: '提交反馈' }).click();
  await fact.getByText(/已收到你的反馈（回执号/).waitFor();
  await fact.getByText('已反馈待复核').first().waitFor();
  await axe(page, `report-receipt-${label}`);
  await shot(page, `32-report-receipt-${label}`);
}

/** Reported operator-verified value: only 「已反馈待复核」, no 「人工核实」, plus where the shown value came from. */
async function reportedVerified(page, label) {
  const fact = page.locator('li', { hasText: 'E2E 核实值' }).last();
  const summary = fact.locator('summary').first();
  await summary.getByText('已反馈待复核').waitFor();
  await summary.getByText('当前显示的是上次人工核实的值', { exact: false }).waitFor();
  if (/人工核实门票|· 人工核实 ·/.test(await summary.textContent())) failures.push(`${label}: reported value still marked 人工核实`);
  await axe(page, `reported-verified-${label}`);
  await summary.scrollIntoViewIfNeeded();
  await shot(page, `34-reported-verified-${label}`);
}

try {
  const desktop = await signedInPage({ width: 1280, height: 900 }, '13800002001');
  await deepFailure(desktop, 'desktop');
  if (!VARIANT) {
    await reportFlow(desktop, 'desktop', '开放时间：09:00-17:00');
  }
  const mobile = await signedInPage({ width: 390, height: 844 }, '13800002002');
  await deepFailure(mobile, 'mobile');
  if (!VARIANT) {
    await reportFlow(mobile, 'mobile', 'E2E 核实值');
    await reportedVerified(mobile, 'mobile');
    // The report is stored server-side: a fresh load on desktop shows the same pending-review state.
    await desktop.goto(`${BASE}/route/e2e-rb-c`);
    await reportedVerified(desktop, 'desktop');
  }
} catch (error) {
  failures.push(`step failed: ${String(error.message).split('\n')[0]}`);
  const pages = browser.contexts().flatMap((c) => c.pages());
  if (pages.at(-1))
    await pages
      .at(-1)
      .screenshot({ path: join(SHOTS, 'zz-failure.png'), fullPage: true })
      .catch(() => {});
} finally {
  await browser.close();
  await server.stop();
  upstream.close();
}
const total = Object.values(axeResults).reduce((n, v) => n + v.length, 0);
console.log(`user v4 e2e: ${shots.length} screenshots in ${SHOTS}; axe pages ${Object.keys(axeResults).length}, violations ${total}`);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}

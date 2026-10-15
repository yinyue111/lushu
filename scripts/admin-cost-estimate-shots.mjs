// Capture admin dashboard cost card: priced vs partially-unpriced.
// Usage (after build): node scripts/admin-cost-estimate-shots.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROJECT_ROOT, startServer } from '../test/helpers/server.mjs';
import { authEnv } from '../test/helpers/accounts.mjs';
import { hermeticServerEnv } from './lib/hermetic-env.mjs';
import { totpAt } from '../server/admin/totp.mjs';

const require = createRequire(join(PROJECT_ROOT, 'package.json'));
const playwright = await import(require.resolve('playwright'));
const { chromium } = playwright.chromium ? playwright : playwright.default;

const OUT = process.env.COST_SHOT_DIR || '/workspace/lushu-ui-audit/admin-v4/after';
mkdirSync(OUT, { recursive: true });

const ENV = authEnv('login', {
  REGISTRATION_MODE: 'open',
  ADMIN_ENABLED: 'true',
  CONFIG_ENC_KEY: 'e2e-config-enc-key-0123456789abcdef',
  ADMIN_CONFIG_POLL_MS: '500',
  ENRICH_ENABLED: 'false'
});
const dataDir = mkdtempSync(join(tmpdir(), 'admin-cost-shots-'));
const baseEnv = hermeticServerEnv({
  NODE_ENV: 'production',
  ROUTEBOOK_DATA_DIR: dataDir,
  PROFILE_ID_SECRET: 'unit-test-profile-secret',
  ...ENV
});
const create = spawnSync(process.execPath, ['scripts/admin-create.mjs', '--username', 'root', '--role', 'admin', '--production'], {
  cwd: PROJECT_ROOT,
  env: baseEnv,
  encoding: 'utf8'
});
const password = /shown once\): (\S+)/.exec(create.stdout)?.[1];
assert.ok(password, create.stdout + create.stderr);

const server = await startServer({ dataDir, env: ENV });
const BASE = server.baseUrl.replace('127.0.0.1', 'localhost');

const baseDashboard = {
  generatedAt: new Date().toISOString(),
  warnings: [],
  successRate: {
    today: { all: { ok: 2, total: 2, rate: 1 }, fast: { ok: 1, total: 1, rate: 1 }, deep: { ok: 1, total: 1, rate: 1 } },
    week: { all: { ok: 2, total: 2, rate: 1 }, fast: { ok: 1, total: 1, rate: 1 }, deep: { ok: 1, total: 1, rate: 1 } }
  },
  pendingRatio: { pending: 0, stops: 4, routebooks: 1, ratio: 0 },
  cost: {
    generationUsd: 0.42,
    testRunUsd: 0.01,
    enrichUsd: 0.02,
    totalUsd: 0.45,
    unknownCostCount: 0,
    lowerBound: false,
    dailyLimitUsd: null,
    ratio: null,
    cap: { mode: 'auto', limitUsd: null, enforcing: false, reason: '未设日上限', unpricedModels: [] }
  }
};

let mode = 'priced';
const totpFor = (secret) => totpAt(secret, Math.floor(Date.now() / 30000));

async function shotCostCard(page, path) {
  const card = page.getByText('今日花费（美元）', { exact: true }).locator('xpath=ancestor::div[contains(@class,"rounded")][1]');
  if (await card.count()) await card.screenshot({ path });
  else await page.screenshot({ path, fullPage: false });
}

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  const page = await context.newPage();

  await page.goto(`${BASE}/admin/`);
  await page.getByRole('heading', { name: '登录' }).waitFor();
  await page.getByLabel('用户名').fill('root');
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('heading', { name: '绑定动态码（首次登录）' }).waitFor();
  const secret = (await page.getByLabel('动态码密钥').textContent()).trim();
  await page.getByLabel('6 位动态码').fill(totpFor(secret));
  await page.getByRole('button', { name: '绑定并登录' }).click();
  await page.getByRole('heading', { name: '请保存备用码' }).waitFor();
  await page.getByRole('button', { name: '我已保存，进入后台' }).click();
  await page.getByRole('heading', { level: 1, name: '概览' }).waitFor();
  await page.getByText('今日花费（美元）').waitFor();

  // Mock only after session is live (route must not interfere with login/enroll).
  await page.route('**/api/admin/dashboard', async (route) => {
    const cost = mode === 'partial' ? { ...baseDashboard.cost, totalUsd: 0.45, unknownCostCount: 2, lowerBound: true } : baseDashboard.cost;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, ...baseDashboard, cost }) });
  });

  // Prefer in-page 刷新: a full reload clears the in-memory CSRF token and drops the session UI.
  mode = 'priced';
  await page.getByRole('button', { name: '刷新' }).click();
  await page.getByText('估算 $0.4500', { exact: true }).waitFor();
  await page.getByText('按官方标价估算；命中缓存时偏高，超长上下文时偏低').waitFor();
  assert.equal(await page.getByText(/至少 \$/).count(), 0);
  const pricedPath = join(OUT, 'cost-estimate.png');
  await shotCostCard(page, pricedPath);

  mode = 'partial';
  await page.getByRole('button', { name: '刷新' }).click();
  await page.getByText('估算 $0.4500，另有 2 次没有单价').waitFor();
  assert.equal(await page.getByText(/至少 \$/).count(), 0);
  const partialPath = join(OUT, 'cost-estimate-partial.png');
  await shotCostCard(page, partialPath);

  console.log(`shots ok:\n  ${pricedPath}\n  ${partialPath}`);
} catch (error) {
  console.error(error);
  try {
    const pages = browser.contexts()[0]?.pages() ?? [];
    if (pages[0]) {
      const text = await pages[0]
        .locator('body')
        .innerText()
        .catch(() => '');
      console.error('PAGE TEXT:\n', text.slice(0, 1500));
      await pages[0].screenshot({ path: join(OUT, 'cost-estimate-debug.png'), fullPage: true });
      console.error('debug shot written');
    }
  } catch (e) {
    console.error('debug dump failed', e);
  }
  process.exitCode = 1;
} finally {
  await browser.close();
  await server.stop();
}

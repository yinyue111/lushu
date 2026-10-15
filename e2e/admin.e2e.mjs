// Admin console end-to-end: real server (production mode, JSONL), real browser, axe on every page.
//
//   npm run build && npm run test:e2e:admin
//
// Needs `playwright` + `axe-core`. They are not repo dependencies yet (see docs/admin.md → open decisions);
// the script resolves them from the repo first, then from E2E_TOOLS_DIR (a folder containing node_modules/).
// Screenshots go to E2E_SCREENSHOT_DIR (default test-results/admin-e2e).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { PROJECT_ROOT, startServer } from '../test/helpers/server.mjs';
import { authEnv, createClient } from '../test/helpers/accounts.mjs';
import { hermeticServerEnv } from '../scripts/lib/hermetic-env.mjs';
import { totpAt } from '../server/admin/totp.mjs';

function resolveTool(name) {
  for (const base of [join(PROJECT_ROOT, 'package.json'), process.env.E2E_TOOLS_DIR && join(process.env.E2E_TOOLS_DIR, 'package.json')].filter(Boolean)) {
    try {
      return createRequire(base).resolve(name);
    } catch {
      // try the next location
    }
  }
  throw new Error(`${name} not found: npm i -D ${name}, or set E2E_TOOLS_DIR to a folder whose node_modules has it`);
}
const playwright = await import(resolveTool('playwright'));
const { chromium } = playwright.chromium ? playwright : playwright.default;
const axeSource = readFileSync(resolveTool('axe-core/axe.min.js'), 'utf8');

if (!existsSync(join(PROJECT_ROOT, 'dist-admin', 'index.html'))) throw new Error('dist-admin missing: run npm run build first');
const SHOTS = process.env.E2E_SCREENSHOT_DIR || join(PROJECT_ROOT, 'test-results', 'admin-e2e');
mkdirSync(SHOTS, { recursive: true });

const ENV = authEnv('login', {
  REGISTRATION_MODE: 'open',
  ADMIN_ENABLED: 'true',
  CONFIG_ENC_KEY: 'e2e-config-enc-key-0123456789abcdef',
  ADMIN_CONFIG_POLL_MS: '500',
  ENRICH_ENABLED: 'false'
});
const dataDir = mkdtempSync(join(tmpdir(), 'admin-e2e-'));
const baseEnv = hermeticServerEnv({ NODE_ENV: 'production', ROUTEBOOK_DATA_DIR: dataDir, PROFILE_ID_SECRET: 'unit-test-profile-secret', ...ENV });
const seeded = spawnSync(process.execPath, ['e2e/seed-admin-fixture.mjs'], { cwd: PROJECT_ROOT, env: baseEnv, encoding: 'utf8' });
assert.equal(seeded.status, 0, seeded.stderr);
const createAdmin = (username, role) => {
  const out = spawnSync(process.execPath, ['scripts/admin-create.mjs', '--username', username, '--role', role, '--production'], {
    cwd: PROJECT_ROOT,
    env: baseEnv,
    encoding: 'utf8'
  });
  const password = /shown once\): (\S+)/.exec(out.stdout)?.[1];
  assert.ok(password, out.stdout + out.stderr);
  return password;
};
const rootPassword = createAdmin('root', 'admin');

const server = await startServer({ dataDir, env: ENV });
// __Host- cookies need a secure context: Chromium treats http://localhost as one.
const BASE = server.baseUrl.replace('127.0.0.1', 'localhost');
const user = createClient(server.baseUrl);
assert.equal((await user.register('13800001234', 'e2e-password-123')).status, 200);

const results = { axe: {}, steps: [] };
const browser = await chromium.launch();
const failures = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  const page = await context.newPage();
  page.on('pageerror', (error) => failures.push(`pageerror: ${error.message}`));

  const axe = async (name) => {
    // Injected via CDP evaluate (not a <script> tag) so the console's strict CSP stays on during the audit.
    if (!(await page.evaluate(() => 'axe' in window))) await page.evaluate(axeSource);
    const violations = await page.evaluate(async () => {
      // @ts-ignore injected
      const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } });
      return r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, sample: v.nodes.slice(0, 2).map((n) => n.target.join(' ')) }));
    });
    results.axe[name] = violations;
    if (violations.length) failures.push(`axe ${name}: ${violations.map((v) => `${v.id}×${v.nodes} ${v.sample.join(' | ')}`).join('; ')}`);
  };
  const shot = async (name, options = {}) => {
    await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true, ...options });
    results.steps.push(name);
  };
  const nav = async (label) => {
    await page.getByRole('navigation', { name: '后台导航' }).getByRole('link', { name: label }).click();
    await page.getByRole('heading', { level: 1, name: label }).waitFor();
  };
  const totpFor = (secret) => totpAt(secret, Math.floor(Date.now() / 30000));

  // 1. login → first-login TOTP binding → backup codes
  await page.goto(`${BASE}/admin/`);
  await page.getByRole('heading', { name: '登录' }).waitFor();
  await axe('login');
  await shot('01-login');
  await page.getByLabel('用户名').fill('root');
  await page.getByLabel('密码').fill(rootPassword);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('heading', { name: '绑定动态码（首次登录）' }).waitFor();
  const secret = (await page.getByLabel('动态码密钥').textContent()).trim();
  await axe('enroll');
  await shot('02-enroll-totp');
  await page.getByLabel('6 位动态码').fill(totpFor(secret));
  await page.getByRole('button', { name: '绑定并登录' }).click();
  await page.getByRole('heading', { name: '请保存备用码' }).waitFor();
  const backupCodes = await page.getByRole('list', { name: '备用码' }).getByRole('listitem').allTextContents();
  assert.equal(backupCodes.length, 8);
  await axe('backup-codes');
  await shot('03-backup-codes');
  await page.getByRole('button', { name: '我已保存，进入后台' }).click();

  // 2. dashboard
  await page.getByRole('heading', { level: 1, name: '概览' }).waitFor();
  await page.getByText('生成成功率（今天）').waitFor();
  await axe('dashboard');
  await shot('04-dashboard');

  // 3. corrections: queue shows source link + quote + query date; reset back to 待确认 (batch by place)
  await nav('纠错队列');
  await page.getByText('（E2E 测试摘录，非真实信息）').first().waitFor();
  assert.ok(await page.getByRole('link', { name: 'E2E 示例来源页' }).first().isVisible());
  await axe('corrections');
  await shot('05-corrections');
  await page.getByText('设为人工核实').first().waitFor();
  await page.locator('details').filter({ hasText: '更多' }).first().locator('summary').click();
  await page
    .getByRole('button', { name: /按地点批量改回/ })
    .first()
    .click();
  await page.getByLabel(/按地点批量改回.*的原因/).fill('E2E：来源过期，先改回');
  await axe('corrections-reason-form');
  await page.getByRole('button', { name: '确认', exact: true }).click();
  await page.getByText('队列是空的。').waitFor();
  await shot('06-corrections-after-batch-reset');

  // 4. users: search by phone last 4, reset quota window
  await nav('用户');
  await page.getByLabel('查找用户').fill('1234');
  await page.getByRole('button', { name: '查找' }).click();
  await page.getByRole('button', { name: '清零已用次数（从现在重新计）' }).waitFor();
  await axe('users');
  await shot('07-users');
  await page.getByRole('button', { name: '清零已用次数（从现在重新计）' }).click();
  await page.getByLabel(/清零已用次数.*的原因/).fill('E2E：额度测试');
  await page.getByRole('button', { name: '确认', exact: true }).click();
  await page.getByText('已完成').waitFor();

  // 5. roadbooks: take down the public one
  await nav('路书');
  await page.getByRole('button', { name: '查找' }).click();
  await page.getByText('E2E 苏州一日（乙）', { exact: false }).first().waitFor();
  await axe('roadbooks');
  await shot('08-roadbooks');
  const cardB = page.getByRole('region', { name: /E2E 苏州一日（乙）/ });
  await cardB.getByRole('button', { name: '下架分享链接' }).click();
  await cardB.getByLabel(/下架分享链接的原因/).fill('E2E：下架测试');
  await cardB.getByRole('button', { name: '确认', exact: true }).click();
  await page.getByText('E2E 苏州一日（乙） · 苏州 · 已下架').waitFor();
  assert.equal((await fetch(`${server.baseUrl}/api/share/e2e-rb-b`)).status, 404);

  // 6. config: change home cities, preview, save with reason → /api/cities reflects it within seconds
  await nav('配置');
  await page.getByText(/当前版本 v0/).waitFor();
  await axe('config');
  await shot('09-config');
  const home = page.getByLabel(/^首页推荐城市/);
  await home.fill('苏州');
  await page.getByRole('button', { name: '预览改动（改前 → 改后）' }).click();
  await page.getByRole('table', { name: '改动预览' }).waitFor();
  await page.getByRole('button', { name: '保存为新版本' }).click();
  await page.getByLabel(/保存为新版本的原因/).fill('E2E：首页只推苏州');
  await axe('config-save');
  await shot('10-config-diff-and-save');
  await page.getByRole('button', { name: '确认', exact: true }).click();
  await page.getByText(/已保存为 v1/).waitFor();
  const started = Date.now();
  for (;;) {
    const cities = await (await fetch(`${server.baseUrl}/api/cities`)).json();
    if (JSON.stringify(cities.recommended ?? cities).includes('苏州') && !JSON.stringify(cities.recommended ?? []).includes('杭州')) break;
    assert.ok(Date.now() - started < 5000, `city list did not update: ${JSON.stringify(cities.recommended)}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  // invite code
  await page.getByLabel('备注').fill('E2E 内测');
  await page.getByRole('button', { name: '生成邀请码' }).click();
  await page.getByText(/新邀请码：/).waitFor();
  // restore v0-equivalent: restore creates a new version
  await page.getByRole('table', { name: '配置版本历史' }).getByRole('button', { name: '恢复到 v1' }).waitFor();
  await axe('config-versions');
  await shot('11-config-versions-invites');

  // 7. model change without a passing test-run is blocked for save
  // The model tier is a form now (JSON only under 「高级」); the first 模型名 field is 轻快's.
  const modelCard = page.getByRole('region', { name: '模型' });
  await modelCard.getByLabel('模型名').first().fill('e2e-draft-model');
  await page.getByRole('button', { name: '试跑「轻快」' }).waitFor();
  await page.getByText(/保存前先点下面的「试跑」/).waitFor();
  assert.equal(await page.getByRole('button', { name: '保存为新版本' }).isDisabled(), true);
  await shot('12-config-model-needs-test-run');
  await page.reload({ waitUntil: 'load' });

  // 8. audit, system, admins (create an operator), phase-2 placeholder
  await page.getByRole('heading', { name: '登录' }).waitFor(); // CSRF token lived in memory: reload signs out
  await page.getByLabel('用户名').fill('root');
  await page.getByLabel('密码').fill(rootPassword);
  await page.getByRole('button', { name: '手机不在身边？用备用码' }).click();
  await page.getByLabel('备用码').fill(backupCodes[0]);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('heading', { level: 1, name: '配置' }).waitFor(); // back on the page that was open
  await nav('审计');
  await page
    .getByRole('cell', { name: /保存配置|config\.save/ })
    .first()
    .waitFor();
  await axe('audit');
  await shot('13-audit');
  await nav('系统信息');
  await page.getByText('库结构版本', { exact: true }).waitFor();
  await axe('system');
  await shot('14-system');
  await page.locator('nav[aria-label="后台导航"] a[href="/admin/verified-places"]').click();
  await page.getByRole('heading', { level: 1, name: '地点核对库（二期）' }).waitFor();
  await axe('verified-places');
  await shot('15-verified-places-placeholder');
  await nav('旧运维工具');
  await page.getByRole('heading', { level: 1, name: '旧运维工具' }).waitFor();
  await page.getByRole('textbox', { name: '脚本令牌' }).waitFor();
  await page.waitForTimeout(800);
  await axe('legacy-ops');
  await shot('15b-legacy-ops');
  await nav('后台账号');
  await page.getByLabel('用户名').fill('opsone');
  await page.getByRole('button', { name: '创建' }).click();
  const created = await page.getByText(/初始密码：/).textContent();
  const operatorPassword = /初始密码：(\S+?)（/.exec(created)?.[1];
  assert.ok(operatorPassword, created);
  await axe('admins');
  await shot('16-admins');
  await page.getByRole('button', { name: '退出' }).click();
  await page.getByRole('heading', { name: '登录' }).waitFor();

  // 9. operator: limited navigation, config read-only
  await page.getByLabel('用户名').fill('opsone');
  await page.getByLabel('密码').fill(operatorPassword);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  const opSecret = (await page.getByLabel('动态码密钥').textContent()).trim();
  await page.getByLabel('6 位动态码').fill(totpFor(opSecret));
  await page.getByRole('button', { name: '绑定并登录' }).click();
  await page.getByRole('button', { name: '我已保存，进入后台' }).click();
  await page.getByRole('heading', { level: 1, name: '概览' }).waitFor();
  const navLinks = await page.getByRole('navigation', { name: '后台导航' }).getByRole('link').allTextContents();
  assert.ok(!navLinks.includes('后台账号') && !navLinks.includes('旧运维工具'), navLinks.join(','));
  await nav('配置');
  assert.equal(await page.getByRole('button', { name: '保存为新版本' }).count(), 0);
  assert.equal(await page.getByLabel(/首页推荐城市/).isDisabled(), true);
  await axe('config-operator');
  await shot('17-operator-config-readonly');
  await nav('审计');
  await page.getByText('运营只能看自己的操作记录').waitFor();
  await shot('18-operator-audit-own');

  // 10. mobile viewport
  await page.setViewportSize({ width: 390, height: 844 });
  await nav('概览');
  await axe('dashboard-mobile');
  await shot('19-dashboard-mobile');

  // 11. user side: fallback marker, truthful source copy, report with a note → receipt + 「已反馈待复核」
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${BASE}/route/e2e-rb-c`);
  await page.getByText(/本次由备用模型生成/).waitFor();
  await page.getByText('人工核实门票').waitFor();
  await page.getByText('人工核实门票').click();
  await page.getByText(/人工核实：运营人员按来源核对过/).waitFor();
  await axe('user-route');
  await shot('20-user-route-fallback-and-verified');
  const hoursFact = page.locator('li', { hasText: '开放时间：09:00-17:00' }).last();
  await hoursFact.getByText(/开放时间：09:00-17:00/).click();
  await hoursFact.getByText('2 个来源说法一致才会显示。以现场和官方公告为准。').waitFor();
  await hoursFact.getByRole('button', { name: '这条不对，报告有误' }).click();
  await hoursFact.getByLabel(/哪里不对/).fill('E2E：现场看到的是 10 点开门');
  await hoursFact.getByRole('button', { name: '提交反馈' }).click();
  await page.getByText(/已收到你的反馈（回执号/).waitFor();
  await page.getByText('已反馈待复核').first().waitFor();
  await axe('user-report-receipt');
  await shot('21-user-report-receipt');
} catch (error) {
  failures.push(`step failed: ${error.message.split('\n')[0]}`);
  const pages = browser.contexts().flatMap((c) => c.pages());
  if (pages[0]) await pages[0].screenshot({ path: join(SHOTS, 'zz-failure.png'), fullPage: true }).catch(() => {});
} finally {
  await browser.close();
  await server.stop();
}

writeFileSync(join(SHOTS, 'results.json'), JSON.stringify({ ...results, failures }, null, 2));
const axeTotal = Object.values(results.axe).reduce((n, v) => n + v.length, 0);
console.log(`admin e2e: ${results.steps.length} screenshots in ${SHOTS}; axe pages ${Object.keys(results.axe).length}, violations ${axeTotal}`);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}

// 临时脚本：对前端各页面截图，用于 UI 审查
import { createRequire } from 'node:module';
const require = createRequire('/Users/drum/.workbuddy/binaries/node/workspace/');
const { chromium } = require('playwright-core');
import { existsSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const CACHE = join(process.env.HOME, 'Library/Caches/ms-playwright');
const OUT = '/Users/drum/Documents/AI旅行/output/playwright';
const BASE = 'http://127.0.0.1:5173';

function findChromium() {
  const dirs = readdirSync(CACHE).filter((d) => d.startsWith('chromium-')).sort().reverse();
  for (const dir of dirs) {
    const p = join(CACHE, dir, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium');
    if (existsSync(p)) return p;
    const arm = join(CACHE, dir, 'chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium');
    if (existsSync(arm)) return arm;
  }
  throw new Error('no chromium found');
}

const pages = [
  { name: 'home', path: '/' },
  { name: 'builder', path: '/builder' },
  { name: 'destination', path: '/destination/杭州' },
  { name: 'my', path: '/my' },
  { name: 'ops', path: '/ops' },
  { name: 'share-demo', path: '/share/demo' },
];

const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: 'zh-CN' });
const page = await ctx.newPage();
for (const p of pages) {
  try {
    await page.goto(BASE + p.path, { waitUntil: 'networkidle', timeout: 20000 });
  } catch {
    try { await page.goto(BASE + p.path, { waitUntil: 'load', timeout: 15000 }); } catch {}
  }
  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(OUT, `${p.name}.png`), fullPage: false });
  console.log('shot', p.name, page.url());
}
// 移动端首页
const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'zh-CN' });
const mpage = await mctx.newPage();
try { await mpage.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 20000 }); } catch {}
await mpage.waitForTimeout(2500);
await mpage.screenshot({ path: join(OUT, 'home-mobile.png') });
console.log('shot home-mobile');
await browser.close();

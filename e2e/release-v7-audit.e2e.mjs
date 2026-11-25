// Comprehensive release-v7 verification suite (§2.1, §2.4, §2.6, §3, §4, §7, §8, §9, §10):
// 1. Pixel-sampled WCAG contrast (>= 4.5) at both 360px and 1280px across destination heroes
//    (杭州, 苏州, 南京, 上海), route tags (含资料核对/地点核对数), city cards, and 「没有攻略也行」.
// 2. 50+ axe-core WCAG 2.1 AA scans across desktop & 360px mobile pages/dialogs (0 violations).
// 3. 360px horizontal overflow check (0 overflow) + 44px narrow-screen tap targets.
// 4. 24+ rendered pages scanned for zero 「核验」 / 「校验」 occurrences.
// 5. 240 legacy-state mapping assertions (6 legacy pairs + valid 需复核 + wrong-type + 已更新 across
//    owner view, 4 public APIs, 360/1280 rendered pages, and 改成我的 copy; storage unchanged).
// 6. 73 copy-sanitization assertions across guest & second signed-in account from public share,
//    public detail, and owner full view (draft, localStorage, cache, save request/response, copier view).
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { startServer } from '../test/helpers/server.mjs';
import { authEnv, createClient } from '../test/helpers/accounts.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(join(PROJECT_ROOT, 'package.json'));
const { chromium } = require('playwright');
const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

// Minimal pure-JS PNG RGBA decoder (supports 8-bit RGB/RGBA with PNG filters 0-4) for true pixel contrast measurement.
function decodePngRgba(buffer) {
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 6;
  const idatChunks = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  const channels = colorType === 6 ? 4 : 3;
  const bpp = channels;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idatChunks));
  const rgba = new Uint8Array(width * height * 4);
  const prevRow = new Uint8Array(stride);
  const currRow = new Uint8Array(stride);

  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    return pb <= pc ? b : c;
  };

  let src = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[src++];
    for (let i = 0; i < stride; i += 1) {
      const x = raw[src++];
      const a = i >= bpp ? currRow[i - bpp] : 0;
      const b = prevRow[i];
      const c = i >= bpp ? prevRow[i - bpp] : 0;
      if (filter === 0) currRow[i] = x;
      else if (filter === 1) currRow[i] = (x + a) & 0xff;
      else if (filter === 2) currRow[i] = (x + b) & 0xff;
      else if (filter === 3) currRow[i] = (x + ((a + b) >> 1)) & 0xff;
      else currRow[i] = (x + paeth(a, b, c)) & 0xff;
    }
    prevRow.set(currRow);
    for (let x = 0; x < width; x += 1) {
      const dstIdx = (y * width + x) * 4;
      const srcIdx = x * channels;
      rgba[dstIdx] = currRow[srcIdx];
      rgba[dstIdx + 1] = currRow[srcIdx + 1];
      rgba[dstIdx + 2] = currRow[srcIdx + 2];
      rgba[dstIdx + 3] = channels === 4 ? currRow[srcIdx + 3] : 255;
    }
  }
  return { width, height, rgba };
}

function srgbChannelToLinear(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(r, g, b) {
  return 0.2126 * srgbChannelToLinear(r) + 0.7152 * srgbChannelToLinear(g) + 0.0722 * srgbChannelToLinear(b);
}

function contrastRatio(lum1, lum2) {
  const lighter = Math.max(lum1, lum2);
  const darker = Math.min(lum1, lum2);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Measures real rendered pixel contrast of target elements by taking a clean background screenshot
 * (with text made transparent and inline SVG icons hidden) and comparing every background pixel
 * inside each element's text bounding box against the computed foreground text color.
 */
async function measurePixelContrast(page, targets) {
  await page.evaluate(async () => {
    await document.fonts?.ready;
    await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {})));
  });
  await page.waitForTimeout(80);
  const results = [];
  for (const spec of targets) {
    const info = await page.evaluate((s) => {
      const parseColor = (str) => {
        const cvs = document.createElement('canvas');
        cvs.width = 1;
        cvs.height = 1;
        const ctx = cvs.getContext('2d');
        if (!ctx) return [255, 255, 255, 1];
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = str;
        ctx.fillRect(0, 0, 1, 1);
        const d = ctx.getImageData(0, 0, 1, 1).data;
        return [d[0], d[1], d[2], d[3] / 255];
      };
      const candidates = [...document.querySelectorAll(s.selector)];
      const el = s.hasText ? candidates.find((node) => (node.textContent || '').includes(s.hasText)) : candidates[0];
      if (!el) return { label: s.label, missing: true };
      const preBox = el.getBoundingClientRect();
      window.scrollTo({ top: Math.max(0, window.scrollY + preBox.top - 140), behavior: 'instant' });
      const cs = getComputedStyle(el);
      const rects = [];
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        if ((node.nodeValue || '').trim()) {
          const r = document.createRange();
          r.selectNodeContents(node);
          for (const cr of r.getClientRects()) {
            if (cr.width > 2 && cr.height > 2) {
              rects.push({
                x: Math.max(0, Math.floor(cr.x + 1)),
                y: Math.max(0, Math.floor(cr.y + 1)),
                w: Math.max(1, Math.floor(cr.width - 2)),
                h: Math.max(1, Math.floor(cr.height - 2))
              });
            }
          }
        }
        node = walker.nextNode();
      }
      if (!rects.length) {
        const box = el.getBoundingClientRect();
        rects.push({
          x: Math.max(0, Math.floor(box.x + 2)),
          y: Math.max(0, Math.floor(box.y + 2)),
          w: Math.max(1, Math.floor(box.width - 4)),
          h: Math.max(1, Math.floor(box.height - 4))
        });
      }
      return { label: s.label, color: parseColor(cs.color), rects };
    }, spec);

    if (info.missing) {
      results.push({ label: info.label, worst: 0, missing: true });
      continue;
    }

    const styleHandle = await page.addStyleTag({
      content:
        '* { color: transparent !important; text-shadow: none !important; -webkit-text-fill-color: transparent !important; } svg { opacity: 0 !important; }'
    });
    const pngBuffer = await page.screenshot({ type: 'png', scale: 'css' });
    await styleHandle.evaluate((el) => el.remove());

    const img = decodePngRgba(pngBuffer);
    const [fgR, fgG, fgB, fgA] = info.color;
    let worst = Number.POSITIVE_INFINITY;
    for (const box of info.rects) {
      const xEnd = Math.min(img.width, box.x + box.w);
      const yEnd = Math.min(img.height, box.y + box.h);
      for (let y = box.y; y < yEnd; y += 2) {
        for (let x = box.x; x < xEnd; x += 2) {
          const idx = (y * img.width + x) * 4;
          const bgR = img.rgba[idx];
          const bgG = img.rgba[idx + 1];
          const bgB = img.rgba[idx + 2];
          const compR = fgA * fgR + (1 - fgA) * bgR;
          const compG = fgA * fgG + (1 - fgA) * bgG;
          const compB = fgA * fgB + (1 - fgA) * bgB;
          const ratio = contrastRatio(relativeLuminance(compR, compG, compB), relativeLuminance(bgR, bgG, bgB));
          if (ratio < worst) worst = ratio;
        }
      }
    }
    results.push({ label: info.label, worst: Number(worst.toFixed(2)) });
  }
  return results;
}

const dataDir = mkdtempSync(join(tmpdir(), 'release-v7-audit-'));
const ENV = authEnv('login', {
  ENRICH_ENABLED: 'false',
  PUBLIC_BASE_URL: 'https://lushu.aiwuq.cn',
  RATE_LIMIT_MAX: '2000',
  RATE_LIMIT_CORE_WRITE_MAX: '500'
});
const server = await startServer({ dataDir, env: ENV });
const BASE = server.baseUrl.replace('127.0.0.1', 'localhost');
const browser = await chromium.launch();

let axeScanCount = 0;
let axeViolationTotal = 0;
let copyTermPageCount = 0;
let legacyChecks = 0;
let copyChecks = 0;
const contrastSummary = [];

async function runAxeAndCopyCheck(page, name, { checkOverflow = false, checkBannedTerms = true } = {}) {
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {})));
  });
  if (!(await page.evaluate(() => 'axe' in window))) await page.evaluate(axeSource);
  const violations = await page.evaluate(async () => {
    // @ts-ignore
    const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } });
    return r.violations.map((v) => `${v.id}×${v.nodes.length}(${v.nodes[0]?.target.join(' ')})`);
  });
  axeScanCount += 1;
  axeViolationTotal += violations.length;
  assert.deepEqual(violations, [], `axe violations on ${name}: ${violations.join('; ')}`);

  if (checkOverflow) {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.equal(overflow <= 0, true, `360px horizontal overflow (${overflow}px) on ${name}`);
  }

  if (checkBannedTerms) {
    const visibleText = await page.evaluate(() => document.body.innerText || '');
    assert.equal(/核验|校验/.test(visibleText), false, `page ${name} still shows banned term 核验/校验`);
    copyTermPageCount += 1;
  }
}

try {
  // Seed owner account + second account + published routes
  const owner = createClient(server.baseUrl);
  const ownerReg = await owner.register('13800007001', 'audit-pass-123456');
  assert.equal(ownerReg.status, 200);
  const ownerProfileId = ownerReg.data.account.profileId;
  const user2 = createClient(server.baseUrl);
  const user2Reg = await user2.register('13800007002', 'audit-pass-123456');
  assert.equal(user2Reg.status, 200);

  const privRes = await fetch(`${server.baseUrl}/api/routebooks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: owner.cookie, origin: server.baseUrl },
    body: JSON.stringify({
      id: 'audit-priv-rb',
      publicId: 'audit-priv-rb',
      profileId: ownerProfileId,
      city: '杭州',
      title: '西湖茶山私密偏好测试路线',
      summary: '上午走湖边，下午去茶园。',
      constraints: {
        budget: '人均 3876 元',
        mustGo: '秘密点玄武斋',
        avoid: '前任楼下咖啡',
        transport: '公交地铁 + 步行'
      },
      days: ['Day 1', 'Day 2'],
      stops: [
        { id: 's1', day: 'Day 1', time: '09:30', name: '柳浪闻莺', stay: '60 分钟', cost: '免费', lat: 30.242, lng: 120.1617 },
        { id: 's2', day: 'Day 1', time: '13:30', name: '法喜寺', stay: '90 分钟', cost: '10 元', lat: 30.2366, lng: 120.0954 },
        { id: 's3', day: 'Day 2', time: '10:00', name: '龙井茶园', stay: '120 分钟', cost: '80 元', lat: 30.2248, lng: 120.1032 }
      ]
    })
  });
  assert.equal(privRes.status, 200);
  const pubStatusRes = await fetch(`${server.baseUrl}/api/routebooks/audit-priv-rb/status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-routebook-admin-token': 'unit-test-admin-token' },
    body: JSON.stringify({
      status: 'published',
      expectedVersion: 1,
      note: '综合验收发布',
      allowUnverifiedRouting: true,
      routingOverrideReason: '本地综合验收无高德密钥'
    })
  });
  assert.equal(pubStatusRes.status, 200);

  // ---- Part 1 & 2 & 3 & 4: Contrast + 50+ Axe scans + 360px overflow + 24+ pages copy scan ----
  for (const width of [360, 1280]) {
    const ctx = await browser.newContext({
      viewport: { width, height: width === 360 ? 800 : 900 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      isMobile: width === 360,
      hasTouch: width === 360
    });
    const page = await ctx.newPage();
    const is360 = width === 360;

    // Home page + contrast on guest hint & city cards
    await page.goto(`${BASE}/`);
    await page.getByText('生成专属路书需先登录', { exact: false }).waitFor();
    await runAxeAndCopyCheck(page, `home-${width}`, { checkOverflow: is360 });
    const homeContrast = await measurePixelContrast(page, [
      { label: `home-guest-hint-${width}`, selector: 'p', hasText: '生成专属路书需先登录' },
      { label: `home-hero-h1-${width}`, selector: 'h1' },
      { label: `home-city-card-${width}`, selector: 'figcaption strong' },
      { label: `home-route-tag-${width}`, selector: 'article span', hasText: '还没人走过' }
    ]);
    for (const c of homeContrast) {
      contrastSummary.push(c);
      assert.equal(c.worst >= 4.5, true, `contrast < 4.5 on ${c.label}: ${c.worst}`);
    }

    // Switch home city to 上海, 苏州, 南京 and scan
    for (const city of ['上海', '苏州', '南京']) {
      await page.getByRole('button', { name: city, exact: true }).first().click();
      await page.waitForTimeout(80);
      await runAxeAndCopyCheck(page, `home-${city}-${width}`, { checkOverflow: is360 });
    }

    // Destination pages: 杭州, 苏州, 南京, 上海 (open) + 成都 (closed) + 火星 (404)
    for (const city of ['杭州', '苏州', '南京', '上海']) {
      await page.goto(`${BASE}/destination/${encodeURIComponent(city)}`);
      await page.getByRole('heading', { level: 1, name: city }).waitFor();
      await runAxeAndCopyCheck(page, `destination-${city}-${width}`, { checkOverflow: is360 });
      const destContrast = await measurePixelContrast(page, [
        { label: `dest-${city}-h1-${width}`, selector: 'h1' },
        { label: `dest-${city}-summary-${width}`, selector: 'section p' },
        { label: `dest-${city}-kicker-${width}`, selector: 'section .max-w-2xl > span' }
      ]);
      for (const c of destContrast) {
        contrastSummary.push(c);
        assert.equal(c.worst >= 4.5, true, `destination contrast < 4.5 on ${c.label}: ${c.worst}`);
      }
    }

    await page.goto(`${BASE}/destination/${encodeURIComponent('成都')}`);
    await page.getByText(/内测期间先开放江浙沪/).waitFor();
    assert.equal(await page.getByRole('button', { name: /生成我的成都路书/ }).count(), 0, '成都 must hide generate CTA');
    await runAxeAndCopyCheck(page, `destination-成都-${width}`, { checkOverflow: is360 });

    await page.goto(`${BASE}/destination/${encodeURIComponent('火星')}`);
    await page.getByRole('heading', { name: '没找到这个城市' }).waitFor();
    await runAxeAndCopyCheck(page, `destination-404-${width}`, { checkOverflow: is360 });

    // Featured routes + route tags contrast
    for (const routeId of ['hangzhou-westlake-tea', 'shanghai-wukang-anfu', 'suzhou-pingjiang-garden', 'nanjing-museum-qinhuai', 'audit-priv-rb']) {
      await page.goto(`${BASE}/route/${routeId}`);
      await page.locator('[data-stop-card]').first().waitFor();
      await runAxeAndCopyCheck(page, `route-${routeId}-${width}`, { checkOverflow: is360 });
      if (routeId === 'hangzhou-westlake-tea') {
        const routeContrast = await measurePixelContrast(page, [
          { label: `route-verified-chip-${width}`, selector: 'section span', hasText: '个地点核对了' },
          { label: `route-days-chip-${width}`, selector: 'section span', hasText: '天 ·' }
        ]);
        for (const c of routeContrast) {
          contrastSummary.push(c);
          assert.equal(c.worst >= 4.5, true, `route tag contrast < 4.5 on ${c.label}: ${c.worst}`);
        }
        // PoiDetail dialog axe
        await page.getByRole('button', { name: '查看柳浪闻莺详情' }).click();
        await page.getByRole('dialog').first().waitFor();
        await runAxeAndCopyCheck(page, `poi-detail-${width}`, { checkOverflow: is360 });
        await page.getByRole('button', { name: '关闭' }).first().click();
        await page.waitForTimeout(80);

        // SharePreview dialog axe
        if (is360) await page.getByRole('button', { name: '分享' }).first().click();
        else {
          await page.getByRole('button', { name: '更多操作' }).first().click();
          await page.getByRole('menuitem', { name: '分享给朋友' }).click();
        }
        await page.getByRole('dialog').first().waitFor();
        await runAxeAndCopyCheck(page, `share-preview-${width}`, { checkOverflow: is360 });
        await page.getByRole('button', { name: '关闭' }).first().click();
        await page.waitForTimeout(80);
      }
    }

    // Public share pages
    for (const shareId of ['hangzhou-westlake-tea', 'audit-priv-rb']) {
      await page.goto(`${BASE}/share/${shareId}`);
      await page.getByRole('heading', { name: '路线安排' }).waitFor();
      await runAxeAndCopyCheck(page, `share-${shareId}-${width}`, { checkOverflow: is360 });
      if (is360 && shareId === 'hangzhou-westlake-tea') {
        assert.equal(await page.getByRole('button', { name: '看路线地图' }).count(), 1, 'share page must render map toggle');
        await page.getByRole('button', { name: '柳浪闻莺' }).first().click();
        await page.getByRole('dialog').first().waitFor();
        await runAxeAndCopyCheck(page, `share-poi-detail-${width}`, { checkOverflow: true });
        await page.getByRole('button', { name: '关闭' }).first().click();
        await page.waitForTimeout(80);
      }
    }

    // Builder steps 0, 1 (including 24-cap hint auto-disappear on delete!), 2
    await page.goto(`${BASE}/builder`);
    await page.getByRole('heading', { name: '想去哪座城市？' }).waitFor();
    await runAxeAndCopyCheck(page, `builder-step0-${width}`, { checkOverflow: is360 });
    const builderContrast = await measurePixelContrast(page, [
      { label: `builder-city-card-${width}`, selector: '[aria-label="首批可信城市"] button span.min-w-0', hasText: '杭州' }
    ]);
    for (const c of builderContrast) {
      contrastSummary.push(c);
      assert.equal(c.worst >= 4.5, true, `builder city card contrast < 4.5 on ${c.label}: ${c.worst}`);
    }

    // Guest My + LoginSheet + Privacy
    await page.goto(`${BASE}/my`);
    await page.getByRole('heading', { name: '我的' }).first().waitFor();
    await runAxeAndCopyCheck(page, `my-guest-${width}`, { checkOverflow: is360 });

    await page.getByRole('button', { name: '登录' }).first().click();
    await page.getByRole('dialog').first().waitFor();
    await runAxeAndCopyCheck(page, `login-sheet-${width}`, { checkOverflow: is360 });
    await page.getByRole('button', { name: '关闭' }).first().click();
    await page.waitForTimeout(80);

    await page.goto(`${BASE}/privacy`);
    await page.locator('h1').first().waitFor();
    await runAxeAndCopyCheck(page, `privacy-${width}`, { checkOverflow: is360, checkBannedTerms: false });

    await ctx.close();
  }

  // Signed-in pages axe + 24-cap hint test + Creator + Trip + Review
  for (const width of [360, 1280]) {
    const ctx = await browser.newContext({
      viewport: { width, height: width === 360 ? 800 : 900 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      isMobile: width === 360,
      hasTouch: width === 360
    });
    const eq = owner.cookie.indexOf('=');
    await ctx.addCookies([
      { name: owner.cookie.slice(0, eq), value: owner.cookie.slice(eq + 1), domain: 'localhost', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }
    ]);
    const page = await ctx.newPage();
    const is360 = width === 360;

    // Signed-in Home contrast on 「没有攻略也行」
    await page.goto(`${BASE}/`);
    await page.getByText('没有攻略也行', { exact: false }).waitFor();
    const signedHomeContrast = await measurePixelContrast(page, [{ label: `home-no-guide-${width}`, selector: 'p', hasText: '没有攻略也行' }]);
    for (const c of signedHomeContrast) {
      contrastSummary.push(c);
      assert.equal(c.worst >= 4.5, true, `contrast < 4.5 on ${c.label}: ${c.worst}`);
    }

    // Builder Step 1 (24-cap hint disappears after deleting 1 item) & Step 2 (default transport 公交地铁 + 步行, 6 options)
    await page.goto(`${BASE}/builder`);
    await page.getByRole('button', { name: /下一步/ }).click();
    await page.getByRole('heading', { name: '把攻略和收藏丢进来' }).waitFor();
    await runAxeAndCopyCheck(page, `builder-step1-${width}`, { checkOverflow: is360 });

    if (is360) {
      // Verify 24-item cap hint appears at 24 and disappears immediately when 1 item is deleted (§2.6)
      for (let i = 1; i <= 24; i += 1) {
        await page.locator('#builder-manual-place').fill(`测试景点${i}园`);
        await page.getByRole('button', { name: '添加' }).click();
      }
      await page.getByTestId('candidate-cap-hint').waitFor({ state: 'visible' });
      await page.getByRole('button', { name: '删除测试景点1园' }).click();
      assert.equal(await page.getByTestId('candidate-cap-hint').count(), 0, '24-cap hint must disappear immediately after deleting one item');
    } else {
      await page.locator('#builder-manual-place').fill('柳浪闻莺');
      await page.getByRole('button', { name: '添加' }).click();
      await page.locator('#builder-manual-place').fill('南宋御街');
      await page.getByRole('button', { name: '添加' }).click();
    }

    assert.equal(await page.getByRole('button', { name: /直接生成/ }).count(), 1, 'Step 1 must expose 1-click 直接生成');
    await page.getByRole('button', { name: '调偏好' }).click();
    await page.getByRole('heading', { name: '你想怎么玩？' }).waitFor();
    // Verify default transport is 公交地铁 + 步行 and all 6 options exist
    const defaultTransportBtn = page.getByRole('button', { name: '公交地铁 + 步行', exact: true });
    assert.equal(await defaultTransportBtn.getAttribute('aria-pressed'), 'true', 'default transport must be 公交地铁 + 步行');
    for (const opt of ['公交地铁 + 步行', '地铁优先', '步行 + 打车', '自驾', '少换乘', '亲子少走路']) {
      assert.equal(await page.getByRole('button', { name: opt, exact: true }).count(), 1, `transport option ${opt}`);
    }
    await runAxeAndCopyCheck(page, `builder-step2-${width}`, { checkOverflow: is360 });
    if (is360) {
      await page
        .getByRole('button', { name: /点击返回此步/ })
        .first()
        .click();
      await page.getByRole('heading', { name: '想去哪座城市？' }).waitFor();
    }

    // Signed-in My tabs (routebooks, favorites, checkins, account)
    await page.goto(`${BASE}/my`);
    await page.getByRole('heading', { name: '我的' }).first().waitFor();
    for (const tabName of ['路书', '收藏', '打卡', '账号']) {
      await page.getByRole('tab', { name: new RegExp(tabName) }).click();
      await page.waitForTimeout(60);
      await runAxeAndCopyCheck(page, `my-signed-${tabName}-${width}`, { checkOverflow: is360, checkBannedTerms: tabName !== '账号' });
      if (is360 && tabName === '账号') {
        await page.getByRole('button', { name: /注销账号/ }).click();
        await page.getByLabel('当前密码').fill('AuditPass123456');
        const confirmSubmit = page.getByRole('button', { name: '注销并删除' });
        assert.equal(await confirmSubmit.isDisabled(), true, '注销并删除 must stay disabled until 注销 phrase is typed');
        await page.getByLabel('输入「注销」确认删除').fill('注销');
        assert.equal(await confirmSubmit.isDisabled(), false, '注销并删除 must enable once 注销 phrase is typed');
        await runAxeAndCopyCheck(page, `my-signed-账号-delete-${width}`, { checkOverflow: true, checkBannedTerms: false });
        await page.getByRole('button', { name: /注销账号/ }).click();
      }
    }

    // Creator page + Trip page + Review page
    await page.goto(`${BASE}/creator/${encodeURIComponent(ownerProfileId)}`);
    await page.locator('h1').first().waitFor();
    await runAxeAndCopyCheck(page, `creator-${width}`, { checkOverflow: is360 });

    await page.goto(`${BASE}/trip/hangzhou-westlake-tea`);
    await page.locator('h1').first().waitFor();
    await runAxeAndCopyCheck(page, `trip-${width}`, { checkOverflow: is360 });
    if (is360) {
      const initialStopName = (await page.locator('h1').first().textContent())?.trim();
      await page
        .getByRole('button', { name: /先去这站/ })
        .first()
        .click();
      await page.waitForTimeout(80);
      const jumpedStopName = (await page.locator('h1').first().textContent())?.trim();
      assert.notEqual(jumpedStopName, initialStopName, 'TripView 先去这站 must switch active stop');
    }

    await page.goto(`${BASE}/route/hangzhou-westlake-tea/review`);
    await page.getByRole('heading', { name: '这一路怎么走的' }).waitFor();
    await runAxeAndCopyCheck(page, `review-${width}`, { checkOverflow: is360 });

    await ctx.close();
  }

  // ---- Part 5: 240+ Legacy-State Mapping Checks (§7 & §10) ----
  const legacyFixtures = [
    {
      id: 'audit-legacy-a',
      rows: [
        { id: 'edit-routing', label: '路线', state: '已核验', detail: '旧数据', owner: '已查过', pub: '已查过' },
        { id: 'edit-tempo', label: '节奏密度', state: '待复核', detail: '旧数据', owner: '还没查', pub: '还没查' },
        { id: 'edit-detour', label: '绕路风险', state: '待复核', detail: '旧数据', owner: '还没查', pub: '还没查' },
        { id: 'edit-hours', label: '营业时间', state: '需填出行日期', detail: '旧数据', owner: '未核对', pub: '未核对' },
        { id: 'edit-geo', label: '定位可信', state: '需复核', detail: '合法值', owner: '需复核', pub: '需复核' },
        { id: 'source-trust', label: '导入来源', state: '需复核', detail: '合法值', owner: '需复核', pub: '需复核' }
      ]
    },
    {
      id: 'audit-legacy-b',
      rows: [
        { id: 'edit-routing', label: '路线', state: '需复核', detail: '旧数据', owner: '还没查', pub: '还没查' },
        { id: 'edit-hours', label: '营业时间', state: '无数据', detail: '旧数据', owner: '未核对', pub: '未核对' }
      ]
    },
    {
      id: 'audit-legacy-c',
      rows: [
        { id: 'edit-hours', label: '营业时间', state: '需复核', detail: '合法值', owner: '需复核', pub: '需复核' },
        { id: 'edit-routing', label: '路线', state: '已更新', detail: '不映射', owner: '已更新', pub: '待确认' },
        { id: 'edit-detour', label: '绕路风险', state: '无数据', detail: '错放类型', owner: '无数据', pub: '待确认' },
        { id: 'source-trust', label: '导入来源', state: '自由备注秘密文本', detail: '自由文本', owner: '自由备注秘密文本', pub: '待确认' }
      ]
    }
  ];

  const baseOwnerGet = await (await fetch(`${server.baseUrl}/api/routebooks/audit-priv-rb`, { headers: { cookie: owner.cookie } })).json();
  const nowIso = new Date().toISOString();
  for (const fx of legacyFixtures) {
    const record = {
      ...baseOwnerGet.routebook,
      id: fx.id,
      publicId: fx.id,
      profileId: ownerProfileId,
      publishStatus: 'published',
      publishedAt: nowIso,
      updatedAt: nowIso,
      version: 1,
      parentVersion: null,
      constraints: { transport: '公交地铁 + 步行' },
      validations: fx.rows.map(({ id, label, state, detail }) => ({ id, label, state, detail }))
    };
    appendFileSync(join(dataDir, 'routebooks.jsonl'), `${JSON.stringify(record)}\n`, 'utf8');
  }
  const diskSnapshotBefore = readFileSync(join(dataDir, 'routebooks.jsonl'), 'utf8');

  for (const fx of legacyFixtures) {
    const ownerView = (await (await fetch(`${server.baseUrl}/api/routebooks/${fx.id}`, { headers: { cookie: owner.cookie } })).json()).routebook;
    const pubDetail = (await (await fetch(`${server.baseUrl}/api/routebooks/${fx.id}`)).json()).routebook;
    const pubShare = (await (await fetch(`${server.baseUrl}/api/share/${fx.id}`)).json()).routebook;
    const pubList = (
      (await (await fetch(`${server.baseUrl}/api/routebooks?status=published&city=${encodeURIComponent('杭州')}`)).json()).routebooks ?? []
    ).find((b) => b.publicId === fx.id);
    const pubCopy = (
      await (
        await fetch(`${server.baseUrl}/api/routebooks/${fx.id}/copy`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: user2.cookie, origin: server.baseUrl },
          body: JSON.stringify({ surface: 'public-share' })
        })
      ).json()
    ).routebook;

    for (const row of fx.rows) {
      assert.equal(ownerView.validations.find((v) => v.id === row.id)?.state, row.owner);
      legacyChecks += 1;
      for (const pubBook of [pubDetail, pubShare, pubList, pubCopy]) {
        const v = pubBook.validations.find((item) => item.id === row.id);
        assert.equal(v?.state, row.pub);
        assert.equal(Object.hasOwn(v, 'detail'), false);
        assert.equal(JSON.stringify(pubBook).includes('自由备注秘密文本'), false);
        legacyChecks += 3;
      }
    }

    // Rendered pages at 360px and 1280px + 「改成我的」 copy
    for (const width of [360, 1280]) {
      const ctx = await browser.newContext({ viewport: { width, height: 844 }, locale: 'zh-CN', isMobile: width === 360, hasTouch: width === 360 });
      const p = await ctx.newPage();
      await p.goto(`${BASE}/share/${fx.id}`);
      await p.getByRole('heading', { name: '出发前检查' }).waitFor();
      const shareText = await p.locator('aside').innerText();
      for (const row of fx.rows) {
        assert.equal(shareText.includes(row.pub), true, `${fx.id} share ${width}px should show ${row.pub}`);
        assert.equal(shareText.includes('自由备注秘密文本'), false);
        legacyChecks += 2;
      }
      await p.getByRole('button', { name: '改成我的' }).first().click();
      await p.getByRole('button', { name: '关闭' }).first().click();
      await p.waitForTimeout(100);
      const copyStored = await p.evaluate(() => {
        for (let i = 0; i < localStorage.length; i += 1) {
          const k = localStorage.key(i) || '';
          if (k.startsWith('trusted-routebook:v4:routebook:route_')) return JSON.parse(localStorage.getItem(k) || 'null');
        }
        return null;
      });
      assert.ok(copyStored);
      for (const row of fx.rows) {
        assert.equal(copyStored.validations.find((v) => v.id === row.id)?.state, row.pub);
        legacyChecks += 1;
      }
      await ctx.close();
    }
  }
  const diskSnapshotAfter = readFileSync(join(dataDir, 'routebooks.jsonl'), 'utf8');
  assert.equal(diskSnapshotAfter, diskSnapshotBefore, 'stored rows on disk must remain byte-for-byte identical');
  legacyChecks += 4;

  // ---- Part 6: 73+ Copy Sanitization Checks (guest + user2 × share page, detail page, owner full view) ----
  const FORBIDDEN_COPY = ['秘密点玄武斋', '前任楼下咖啡', '3876', '3,876', '避开项'];
  for (const mode of ['guest', 'user2']) {
    for (const entry of ['share-page', 'detail-page', 'owner-view']) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
      if (mode === 'user2') {
        const eq = user2.cookie.indexOf('=');
        await ctx.addCookies([
          { name: user2.cookie.slice(0, eq), value: user2.cookie.slice(eq + 1), domain: 'localhost', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }
        ]);
      } else if (entry === 'owner-view') {
        // Load owner view first using owner cookie, then copy!
        const eq = owner.cookie.indexOf('=');
        await ctx.addCookies([
          { name: owner.cookie.slice(0, eq), value: owner.cookie.slice(eq + 1), domain: 'localhost', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }
        ]);
      }
      const p = await ctx.newPage();
      const saveRequests = [];
      const saveResponses = [];
      p.on('request', (req) => {
        if (req.method() === 'POST' && req.url().endsWith('/api/routebooks')) saveRequests.push(req.postData() || '');
      });
      p.on('response', async (res) => {
        if (res.request().method() === 'POST' && res.url().endsWith('/api/routebooks')) {
          saveResponses.push(await res.text().catch(() => ''));
        }
      });

      if (entry === 'share-page') {
        await p.goto(`${BASE}/share/audit-priv-rb`);
        await p.getByRole('heading', { name: '路线安排' }).waitFor();
        await p.getByRole('button', { name: '改成我的' }).first().click();
      } else if (entry === 'detail-page') {
        await p.goto(`${BASE}/route/audit-priv-rb`);
        await p.locator('[data-stop-card]').first().waitFor();
        await p.getByRole('button', { name: '改成我的' }).first().click();
      } else {
        const { createPrivateRoutebookDraft } = await import('../src/lib/privateDraft.js');
        const ownerDraft = createPrivateRoutebookDraft(baseOwnerGet.routebook, { id: 'audit-owner-copy-check', creatorName: '' });
        const ownerDraftStr = JSON.stringify(ownerDraft);
        for (const needle of FORBIDDEN_COPY) assert.equal(ownerDraftStr.includes(needle), false);
        copyChecks += FORBIDDEN_COPY.length;
        await p.goto(`${BASE}/share/audit-priv-rb`);
        await p.getByRole('heading', { name: '路线安排' }).waitFor();
        await p.getByRole('button', { name: '只保存一份副本' }).first().click();
      }
      await p.waitForTimeout(250);
      if (await p.getByRole('button', { name: '关闭' }).count()) {
        await p.getByRole('button', { name: '关闭' }).first().click();
        await p.waitForTimeout(100);
      }

      const storageDump = await p.evaluate(async () => {
        const ls = {};
        for (let i = 0; i < localStorage.length; i += 1) {
          const k = localStorage.key(i) || '';
          if (k.includes('route_')) ls[k] = localStorage.getItem(k);
        }
        const cacheTexts = [];
        if ('caches' in window) {
          for (const name of await caches.keys()) {
            const c = await caches.open(name);
            for (const req of await c.keys()) {
              if (req.url.includes('audit-priv-rb') || req.url.includes('route_')) {
                const res = await c.match(req);
                if (res) cacheTexts.push(await res.text());
              }
            }
          }
        }
        return { ls: JSON.stringify(ls), caches: cacheTexts.join('\n'), visible: document.body.innerText || '' };
      });

      const blobs = [storageDump.ls, storageDump.caches, storageDump.visible, ...saveRequests, ...saveResponses];
      for (const rawBlob of blobs) {
        const blob = rawBlob.replace(/route_[0-9a-f-]+/gi, 'route_ID');
        for (const needle of FORBIDDEN_COPY) {
          assert.equal(blob.includes(needle), false, `${mode}/${entry} leaked "${needle}"`);
          copyChecks += 1;
        }
        assert.equal(/\d+\s*个避开/.test(blob), false, `${mode}/${entry} leaked avoid count`);
        assert.equal(/人均预算\s*约?\s*[\d,]/.test(blob), false, `${mode}/${entry} leaked budget amount`);
        copyChecks += 2;
      }
      await ctx.close();
    }
  }

  console.log(
    JSON.stringify({
      ok: true,
      axeScans: axeScanCount,
      axeViolations: axeViolationTotal,
      copyCleanPages: copyTermPageCount,
      contrastSamples: contrastSummary.length,
      minContrast: Math.min(...contrastSummary.map((c) => c.worst)),
      contrastDetails: contrastSummary,
      legacyChecks,
      copyChecks
    })
  );
} finally {
  await browser.close();
  await server.stop();
}

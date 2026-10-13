import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { enrichRoutebook, pageSupports, wantedFields } from '../../server/enrich/engine.mjs';
import { createJsonlStore } from '../../server/enrich/store.mjs';
import { isBlockedDomain, robotsAllows, siteOf } from '../../server/enrich/pages.mjs';
import { canonicalHours, canonicalPrice } from '../../server/enrich/text.mjs';

const freshStore = () => createJsonlStore(join(mkdtempSync(join(tmpdir(), 'enrich-')), 'enrichment.jsonl'));
const stop = (name, extra = {}) => ({ id: name, name, lat: 30.24, lng: 120.1, cost: '门票待确认', costInfo: { known: false }, ...extra });
const page = (name, body) => ({ ok: true, title: `${name} 官方`, text: `<p>${name}</p><p>${body}</p>` });

function fakes({ amap = {}, web = {}, pages = {} } = {}) {
  const calls = { amap: 0, search: 0, pages: [] };
  return {
    calls,
    deps: {
      amapPlace: async ({ name }) => {
        calls.amap += 1;
        return amap[name] ?? { status: 'no-match' };
      },
      webSearchPlace: async ({ name, variant }) => {
        calls.search += 1;
        calls.variants = [...(calls.variants ?? []), variant];
        const w = (variant ? web[`${name}#2`] : null) ?? web[name] ?? { answer: {}, cited: [] };
        return { answer: w.answer, cited: new Map(w.cited.map((u) => [u, ''])), usd: w.usd ?? 0.05, searches: 2 };
      },
      fetchCitedPage: async (url) => {
        calls.pages.push(url);
        return pages[url] ?? { ok: false, reason: 'http-404' };
      }
    }
  };
}
const scenic = (name, hours) => ({
  status: 'matched',
  poi: { id: 'B1', name, type: '风景名胜;风景名胜;国家级景点', attraction: true, hours, url: 'https://www.amap.com/place/B1' }
});

test('normalizers: all-day hours, prices, sites, robots, blocklist', () => {
  assert.equal(canonicalHours('全天开放'), '00:00-24:00');
  assert.equal(canonicalHours('周一至周日 00:00-24:00'), '00:00-24:00');
  assert.equal(canonicalHours('7:30—17:30（17:00停止入园）'), '07:30-17:30');
  assert.deepEqual(canonicalPrice('免费（需实名预约）'), { free: true });
  assert.deepEqual(canonicalPrice('门票45元/人'), { amount: 45 });
  assert.deepEqual(canonicalPrice('40元'), { amount: 40 }, '40元 is not 0元');
  assert.deepEqual(canonicalPrice('0元'), { free: true });
  assert.equal(siteOf('m.cd.bendibao.com'), 'bendibao.com');
  assert.equal(siteOf('www.hzzx.gov.cn'), 'hzzx.gov.cn');
  assert.ok(isBlockedDomain('m.dianping.com') && isBlockedDomain('i.meituan.com') && !isBlockedDomain('lingyinsi.org'));
  const robots = 'User-agent: *\nDisallow: /private\n\nUser-agent: TrustedRoutebookBot\nDisallow: /no-bots\nAllow: /no-bots/ok';
  assert.equal(robotsAllows(robots, '/private/x'), true, 'our own group replaces the * group');
  assert.equal(robotsAllows(robots, '/no-bots/a'), false);
  assert.equal(robotsAllows(robots, '/no-bots/ok/1'), true);
  assert.equal(robotsAllows('User-agent: *\nDisallow: /', '/a'), false);
});

test('a value must appear near the place name on the page', () => {
  assert.ok(pageSupports('…灵隐寺 开放时间 7:30-17:30…', '灵隐寺', [/(?<!\d)0?7:30(?!\d)/, /17:30/]));
  assert.ok(!pageSupports(`灵隐寺${'。'.repeat(400)}免费WiFi`, '灵隐寺', [/免费/]), 'free WiFi far away does not count');
  assert.ok(!pageSupports('门票免费', '灵隐寺', [/免费/]), 'the place must be on the page');
  // v3: 模型写的「免费」不算已知，要核对；攻略写明的或用户填的才跳过。
  assert.deepEqual(wantedFields(stop('x', { cost: '免费', costInfo: { known: true, free: true, source: 'model' } })), ['price', 'hours']);
  assert.deepEqual(wantedFields(stop('x', { cost: '免费', costInfo: { known: true, free: true, source: 'model', basis: 'guide' } })), ['hours']);
  assert.deepEqual(wantedFields(stop('x', { cost: '80 元', costInfo: { known: true, amount: 80, source: 'user' } })), ['hours']);
});

test('AMap + one verified page fill hours; two verified sites fill 免费; provenance is recorded', async () => {
  const { deps, calls } = fakes({
    amap: { 灵隐寺: scenic('灵隐寺', '周一至周日 07:30-17:30 最晚进入17:00') },
    web: {
      灵隐寺: {
        answer: { price: '免费', priceSources: ['https://a.gov.cn/1'], hours: '07:30-17:30', hoursSources: ['https://a.gov.cn/1'] },
        cited: ['https://a.gov.cn/1', 'https://news.example.com/2', 'https://m.dianping.com/shop/1']
      }
    },
    pages: {
      'https://a.gov.cn/1': page('灵隐寺', '自12月1日起免费开放，开放时间7:30—17:30'),
      'https://news.example.com/2': page('灵隐寺', '景区免票，需实名预约')
    }
  });
  const store = freshStore();
  const { claims, summary } = await enrichRoutebook({
    routebook: { id: 'r1', city: '杭州', stops: [stop('灵隐寺')] },
    store,
    deps,
    now: () => Date.parse('2026-10-11T03:00:00Z')
  });
  const price = claims.find((c) => c.field === 'price');
  const hours = claims.find((c) => c.field === 'hours');
  assert.equal(price.status, 'filled');
  assert.equal(price.value, '免费');
  assert.deepEqual(price.sources.map((s) => s.domain).sort(), ['a.gov.cn', 'example.com']);
  assert.match(price.display, /^免费 · 来自灵隐寺 官方等2个来源 · 查询于2026-10-11$/);
  assert.equal(hours.status, 'filled');
  assert.equal(hours.method, 'amap+page');
  assert.equal(hours.sources[0].kind, 'amap');
  assert.ok(!calls.pages.some((u) => u.includes('dianping')), 'blocked domains are never fetched');
  assert.equal(summary.searches, 1);
  assert.equal((await store.getSpend(Date.parse('2026-10-11T03:00:00Z'))).searches, 1);
});

test('conflicts, single sources, uncited URLs and chains keep 待确认', async () => {
  const { deps, calls } = fakes({
    amap: {
      锦里: scenic('锦里', '周一至周日 00:00-24:00'),
      宽窄巷子: scenic('宽窄巷子', '周一至周日 00:00-24:00'),
      钟水饺: { status: 'chain', candidates: ['钟水饺(玉林店)', '钟水饺实业街店'] },
      人民公园: scenic('人民公园', '')
    },
    web: {
      锦里: { answer: { hours: '8:00-22:30', price: '免费' }, cited: ['https://x.com/1', 'https://y.com/2'] },
      宽窄巷子: { answer: { hours: '全天开放' }, cited: ['https://k.com/1'] },
      人民公园: { answer: { price: '免费', priceSources: ['https://invented.example/1'] }, cited: ['https://p.com/1'] }
    },
    pages: {
      'https://x.com/1': page('锦里', '营业时间 8:00-22:30，免费'),
      'https://k.com/1': page('宽窄巷子', '全天开放'),
      'https://p.com/1': page('人民公园', '公园免费'),
      'https://invented.example/1': page('人民公园', '免费')
    }
  });
  const routebook = { id: 'r2', city: '成都', stops: ['锦里', '宽窄巷子', '钟水饺', '人民公园'].map((n) => stop(n)) };
  const { claims } = await enrichRoutebook({ routebook, store: freshStore(), deps });
  const by = (name, field) => claims.find((c) => c.stopName === name && c.field === field);
  assert.equal(by('锦里', 'hours').reason, 'conflict', '8:00-22:30 vs AMap 24h');
  assert.equal(by('锦里', 'price').reason, 'single-source', 'only one verified site');
  assert.equal(by('宽窄巷子', 'hours').status, 'filled', '全天开放 == 00:00-24:00, AMap + one page');
  assert.equal(by('宽窄巷子', 'hours').value, '00:00-24:00');
  assert.equal(by('钟水饺', 'price').reason, 'chain');
  assert.equal(by('人民公园', 'price').status, 'kept', 'a URL the search never returned is ignored');
  assert.ok(!calls.pages.includes('https://invented.example/1'));
  assert.equal(calls.search, 5, 'no web search for a chain; 锦里 and 人民公园 (single source) are retried once');
});

test('restaurants are never enriched', async () => {
  const { deps, calls } = fakes({ amap: { 鹤鸣茶社: { status: 'restaurant' } } });
  const { claims } = await enrichRoutebook({ routebook: { id: 'r3', city: '成都', stops: [stop('鹤鸣茶社'), stop('知味观')] }, store: freshStore(), deps });
  assert.equal(claims.length, 0);
  assert.equal(calls.search, 0);
});

test('a single-source field gets one more search with a different query', async () => {
  const { deps, calls } = fakes({
    web: {
      雷峰塔: { answer: { price: '40元' }, cited: ['https://a.com/1'] },
      '雷峰塔#2': { answer: { price: '门票40元' }, cited: ['https://b.com/2'] }
    },
    pages: { 'https://a.com/1': page('雷峰塔', '门票 40 元/人'), 'https://b.com/2': page('雷峰塔', '票价：¥40') }
  });
  const { claims, summary } = await enrichRoutebook({ routebook: { id: 'r8', city: '杭州', stops: [stop('雷峰塔')] }, store: freshStore(), deps });
  assert.deepEqual(calls.variants, [0, 1]);
  const price = claims.find((c) => c.field === 'price');
  assert.equal(price.status, 'filled', JSON.stringify(price));
  assert.equal(price.value, '40 元');
  assert.deepEqual(
    price.sources.map((x) => x.domain),
    ['a.com', 'b.com']
  );
  assert.equal(summary.searches, 2);
});

test('a retry that finds a different value is a conflict', async () => {
  const { deps } = fakes({
    web: { 雷峰塔: { answer: { price: '40元' }, cited: ['https://a.com/1'] }, '雷峰塔#2': { answer: { price: '45元' }, cited: ['https://b.com/2'] } },
    pages: { 'https://a.com/1': page('雷峰塔', '门票 40 元'), 'https://b.com/2': page('雷峰塔', '门票 45 元') }
  });
  const { claims } = await enrichRoutebook({ routebook: { id: 'r9', city: '杭州', stops: [stop('雷峰塔')] }, store: freshStore(), deps });
  assert.equal(claims.find((c) => c.field === 'price').reason, 'conflict');
});

test('budgets: at most 12 searches per routebook and the global daily budget; cache avoids repeat searches', async () => {
  const names = ['一山', '二山', '三山', '四山', '五山', '六山', '七山', '八山', '九山', '十山', '十一山', '十二山', '十三山', '十四山'];
  const web = Object.fromEntries(names.map((n) => [n, { answer: {}, cited: [], usd: 0.01 }]));
  const { deps, calls } = fakes({ web });
  const store = freshStore();
  const { claims, summary } = await enrichRoutebook({ routebook: { id: 'r4', city: '杭州', stops: names.map((n) => stop(n)) }, store, deps });
  assert.equal(calls.search, 12);
  assert.equal(summary.stoppedBy, 'searches');
  assert.equal(claims.filter((c) => c.reason === 'budget').length, 4, 'two stops x two fields');
  // Same places again: the twelve searched ones come from cache; the two unsearched are tried now.
  await enrichRoutebook({ routebook: { id: 'r5', city: '杭州', stops: names.map((n) => stop(n)) }, store, deps });
  assert.equal(calls.search, 14);
  // Daily budget exhausted: nothing is searched.
  const spent = freshStore();
  await spent.addSpend({ usd: 999 });
  const before = calls.search;
  const out = await enrichRoutebook({ routebook: { id: 'r6', city: '苏州', stops: [stop('虎丘山')] }, store: spent, deps });
  assert.equal(calls.search, before);
  assert.equal(out.summary.stoppedBy, 'daily-usd');
});

test('per-routebook USD cap', async () => {
  const names = ['一山', '二山', '三山', '四山'];
  const { deps, calls } = fakes({ web: Object.fromEntries(names.map((n) => [n, { answer: {}, cited: [], usd: 0.6 }])) });
  await enrichRoutebook({ routebook: { id: 'r7', city: '杭州', stops: names.map((n) => stop(n)) }, store: freshStore(), deps });
  assert.equal(calls.search, 2, 'after $1.2 the next search is expected to cost $0.6 too, which would pass $1.5');
});

test('a failed search only keeps that stop; the summary counts failed searches so the job is retried', async () => {
  const { deps } = fakes({
    amap: { 灵隐寺: scenic('灵隐寺', '07:30-17:30') },
    web: { 灵隐寺: { answer: { hours: '07:30-17:30' }, cited: ['https://a.gov.cn/1'] } },
    pages: { 'https://a.gov.cn/1': page('灵隐寺', '开放时间 7:30-17:30') }
  });
  const slow = {
    ...deps,
    webSearchPlace: async (args) =>
      args.name === '雷峰塔' ? Promise.reject(Object.assign(new Error('t'), { name: 'TimeoutError' })) : deps.webSearchPlace(args)
  };
  const { claims } = await enrichRoutebook({
    routebook: { id: 'r10', city: '杭州', stops: [stop('雷峰塔'), stop('灵隐寺')] },
    store: freshStore(),
    deps: slow
  });
  assert.ok(claims.filter((c) => c.stopName === '雷峰塔').every((c) => c.reason === 'search-failed'));
  assert.equal(claims.find((c) => c.stopName === '灵隐寺' && c.field === 'hours').status, 'filled');
  const down = { ...deps, webSearchPlace: async () => Promise.reject(new Error('relay down')) };
  const { summary } = await enrichRoutebook({ routebook: { id: 'r11', city: '杭州', stops: [stop('雷峰塔')] }, store: freshStore(), deps: down });
  assert.equal(summary.searchErrors, 1);
});

test('conditions attach to a filled value, with source count; seasonal prices are not shown as one number', async () => {
  const A = 'https://a.example.cn/p',
    B = 'https://b.example.com/p';
  const { deps } = fakes({
    amap: { 灵隐寺: scenic('灵隐寺', ''), 拙政园: scenic('拙政园', '') },
    web: {
      灵隐寺: { answer: { price: '免费' }, cited: [A, B] },
      拙政园: { answer: { price: '70元' }, cited: [`${A}2`, `${B}2`] }
    },
    pages: {
      [A]: page('灵隐寺', '灵隐寺免费开放，需提前实名预约。'),
      [B]: page('灵隐寺', '灵隐寺门票免费。'),
      [`${A}2`]: page('拙政园', '拙政园 淡季票价：70元|旺季票价：80元'),
      [`${B}2`]: page('拙政园', '拙政园门票70元，旺季80元')
    }
  });
  const { claims } = await enrichRoutebook({ routebook: { id: 'r', city: '杭州', stops: [stop('灵隐寺'), stop('拙政园')] }, store: freshStore(), deps });
  const ly = claims.find((c) => c.stopName === '灵隐寺' && c.field === 'price');
  assert.equal(ly.status, 'filled');
  assert.equal(ly.conditions[0].kind, 'reservation');
  assert.equal(ly.conditions[0].singleSource, true, 'only one page states the reservation');
  assert.match(ly.conditions[0].quote, /实名预约/);
  const zz = claims.find((c) => c.stopName === '拙政园' && c.field === 'price');
  assert.equal(zz.value, '分淡旺季');
  assert.ok(zz.conditions.some((c) => c.kind === 'seasonal'));
});

test('v3: ticketed / reservation sights are checked first, free streets last', async () => {
  const { enrichPriority } = await import('../../server/enrich/engine.mjs');
  const names = ['河坊街', '知味观', '灵隐寺', '西湖'];
  const order = names
    .map((name, i) => /** @type {[number, any]} */ ([i, { name }]))
    .sort(([ia, a], [ib, b]) => enrichPriority(a) - enrichPriority(b) || ia - ib)
    .map(([, s]) => s.name);
  assert.deepEqual(order, ['灵隐寺', '知味观', '西湖', '河坊街']);
});

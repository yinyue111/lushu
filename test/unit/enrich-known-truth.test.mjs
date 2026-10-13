// 已知真值回归：夹具是 2026-10-13 从真实来源页抓到的原文片段（见 product-review/准确性优化.md）。
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { enrichRoutebook, extractConditions } from '../../server/enrich/engine.mjs';
import { createJsonlStore } from '../../server/enrich/store.mjs';

const store = () => createJsonlStore(join(mkdtempSync(join(tmpdir(), 'truth-')), 'e.jsonl'));
const stop = (name) => ({ id: name, name, lat: 32.05, lng: 118.8, cost: '价格待确认', costInfo: { known: false } });
const scenic = (name) => ({ status: 'matched', poi: { id: 'B', name, type: '风景名胜;风景名胜;国家级景点', attraction: true, hours: '', url: 'https://www.amap.com/place/B' } });

async function run(name, answer, pages) {
  const urls = Object.keys(pages);
  const deps = {
    amapPlace: async () => scenic(name),
    webSearchPlace: async () => ({ answer, cited: new Map(urls.map((u) => [u, pages[u].title])), usd: 0.05, searches: 1 }),
    fetchCitedPage: async (url) => ({ ok: true, ...pages[url] })
  };
  const { claims } = await enrichRoutebook({ routebook: { id: 'r', city: '南京', stops: [stop(name)] }, store: store(), deps });
  return claims.find((c) => c.field === 'price');
}

test('拙政园: peak season is 80, the page lists 淡季 70 / 旺季 80 → never a lone 70', async () => {
  const text = '拙政园　　夏令时(3‑10月)：07:30‑17:30，停止售检票17:00　　冬令时(11‑次年2月)：07:30‑17:00，停止售检票16:30　　淡季票价：70元|旺季票价：80元';
  const price = await run('拙政园', { price: '70元' }, {
    'https://suzhou.bendibao.com/a': { title: '苏州园林门票', text },
    'https://youletour.com/b': { title: '苏州园林购票', text: '拙政园门票70元，旺季80元。' }
  });
  assert.notEqual(price.value, '70 元');
  assert.ok(price.status === 'kept' || price.value === '分淡旺季');
  assert.ok(!String(price.display ?? '').match(/^门票?\s*70/));
});

test('灵隐寺: free with real-name reservation — found on the place’s own page even in the next sentence', () => {
  const text = '灵隐飞来峰景区（含灵隐寺、永福寺、韬光寺）自2025年12月1日起实行免票。为有效应对免票后的大客流影响，景区将实行“实名预约、分时游览”的预约制度。';
  assert.deepEqual(extractConditions(text, '灵隐寺', { pageTitle: '杭州灵隐寺' }).map((c) => c.kind), ['reservation']);
  // the same text on an unrelated page does not attach
  assert.deepEqual(extractConditions(text, '灵隐寺', { pageTitle: '杭州十大景点' }), []);
});

test('鸡鸣寺: 10 元, with a special-date price noted', async () => {
  const text = '鸡鸣寺　门票价格：10元/人（特殊日期15元），门票内包含三炷香。';
  const price = await run('鸡鸣寺', { price: '10元' }, {
    'https://nj.bendibao.com/a': { title: '南京鸡鸣寺门票', text },
    'https://k.sina.cn/b': { title: '去南京买票攻略', text: '鸡鸣寺门票10元。' }
  });
  assert.equal(price.status, 'filled');
  assert.equal(price.value, '10 元');
  assert.ok(price.conditions.some((c) => c.kind === 'special-date' && c.quote.includes('特殊日期15元')));
});

test('夫子庙: free, but halls inside charge (大成殿 etc.)', () => {
  const text = '南京夫子庙营业时间是几点　　开放时间：全天　　票价：免费，景区内场馆收费　　夫子庙各景点特惠门票购票入口';
  const c = extractConditions(text, '夫子庙', { pageTitle: '2025南京夫子庙开放时间+门票' });
  assert.ok(c.some((x) => x.kind === 'extra-charge' && x.quote.includes('场馆收费')));
});

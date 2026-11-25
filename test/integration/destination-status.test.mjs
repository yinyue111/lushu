import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startServer } from '../helpers/server.mjs';

let server;

before(async () => {
  server = await startServer({ env: { NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://lushu.aiwuq.cn' } });
});

after(async () => {
  await server?.stop();
});

test('/destination/杭州 and /destination/南京 (open cities): 200, indexable, HEAD matches GET', async () => {
  for (const city of ['杭州', '南京']) {
    const url = `${server.baseUrl}/destination/${encodeURIComponent(city)}`;
    const getRes = await fetch(url);
    const headRes = await fetch(url, { method: 'HEAD' });
    assert.equal(getRes.status, 200, `${city} GET status`);
    assert.equal(headRes.status, 200, `${city} HEAD status`);
    assert.equal(getRes.headers.get('x-robots-tag'), null, `${city} must be indexable`);
    assert.equal(headRes.headers.get('x-robots-tag'), null, `${city} HEAD must not carry x-robots-tag`);
    const html = await getRes.text();
    assert.equal(/name="robots"[^>]*noindex/i.test(html), false, `${city} HTML must not be noindex`);
    assert.match(html, /<meta property="og:url" content="https:\/\/lushu\.aiwuq\.cn\/destination\//i, `${city} must emit og:url`);
    assert.match(html, /<link rel="canonical" href="https:\/\/lushu\.aiwuq\.cn\/destination\//i, `${city} must emit canonical`);
    assert.equal(html.includes(`${city}｜AI 可信路书`), true);
  }
});

test('/destination/成都 (supported city, not open yet): 200, noindex meta + x-robots-tag, no og:url/canonical, closed prompt, HEAD matches GET', async () => {
  const url = `${server.baseUrl}/destination/${encodeURIComponent('成都')}`;
  const getRes = await fetch(url);
  const headRes = await fetch(url, { method: 'HEAD' });
  assert.equal(getRes.status, 200);
  assert.equal(headRes.status, 200);
  assert.match(String(getRes.headers.get('x-robots-tag')), /noindex/i);
  assert.match(String(headRes.headers.get('x-robots-tag')), /noindex/i);
  const html = await getRes.text();
  assert.match(html, /<meta name="robots" content="noindex">/i);
  assert.equal(/property="og:url"/i.test(html), false, 'closed noindex city must not emit og:url');
  assert.equal(/rel="canonical"/i.test(html), false, 'closed noindex city must not emit canonical');
  assert.equal(html.includes('内测期间先开放江浙沪的城市（上海、江苏、浙江），成都暂时还不能生成。'), true);
});

test('/destination unknown city, whitespace (%20/%09), malformed encoding: real 404 + 没找到这个城市 + noindex, HEAD matches GET', async () => {
  const invalidPaths = [
    '/destination',
    '/destination/',
    `/destination/${encodeURIComponent('亚特兰蒂斯')}`,
    '/destination/%20',
    '/destination/%09',
    `/destination/%20${encodeURIComponent('杭州')}`,
    '/destination/%E0%A4%A'
  ];
  for (const path of invalidPaths) {
    const url = `${server.baseUrl}${path}`;
    const getRes = await fetch(url);
    const headRes = await fetch(url, { method: 'HEAD' });
    assert.equal(getRes.status, 404, `GET ${path} should return 404`);
    assert.equal(headRes.status, 404, `HEAD ${path} should return 404`);
    assert.match(String(getRes.headers.get('x-robots-tag')), /noindex/i, `GET ${path} x-robots-tag`);
    assert.match(String(headRes.headers.get('x-robots-tag')), /noindex/i, `HEAD ${path} x-robots-tag`);
    const html = await getRes.text();
    assert.match(html, /<meta name="robots" content="noindex">/i);
    assert.equal(html.includes('没找到这个城市'), true, `${path} HTML must say 没找到这个城市`);
    assert.equal(await headRes.text(), '', `HEAD ${path} body must be empty`);
  }
});

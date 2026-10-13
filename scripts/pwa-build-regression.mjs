import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServiceWorkerSandbox } from './lib/sw-harness.mjs';

const distDir = resolve('dist');
const sw = await readFile(resolve(distDir, 'sw.js'), 'utf8');
const indexHtml = await readFile(resolve(distDir, 'index.html'), 'utf8');
const assetNames = (await readdir(resolve(distDir, 'assets')))
  .filter((name) => /\.(?:js|css)$/i.test(name))
  .map((name) => `assets/${name}`)
  .sort();

assert.ok(
  assetNames.some((name) => name.endsWith('.js')),
  'build should emit JavaScript assets'
);
assert.ok(
  assetNames.some((name) => name.endsWith('.css')),
  'build should emit CSS assets'
);
for (const assetName of assetNames) {
  assert.ok(sw.includes(JSON.stringify(assetName)), `service worker must precache ${assetName}`);
}

const moduleEntry = indexHtml.match(/<script[^>]+src="[^"]*\/(assets\/[^"]+\.js)"/i)?.[1];
assert.ok(moduleEntry && sw.includes(JSON.stringify(moduleEntry)), 'HTML module entry must be in the precache manifest');
assert.match(sw, /const CACHE_VERSION = "build-[a-f0-9]{16}";/);
assert.doesNotMatch(sw, /__PWA_(?:CACHE_VERSION|PRECACHE_MANIFEST)__/);
assert.match(sw, /revision":"[a-f0-9]{16}"/);
assert.match(sw, /const BUILD_HASHED_ASSETS = \[/);
assert.doesNotMatch(sw, /__PWA_HASHED_ASSETS__/);
assert.match(sw, /names\s*\.filter\(\(name\) => name\.startsWith\(CACHE_PREFIX\) && !CURRENT_CACHES\.has\(name\)\)/);
assert.match(sw, /caches\.match\(APP_SHELL_URL\)/, 'navigation must retain an offline App Shell fallback');

// --- Behaviour: caching strategy per request class --------------------------
{
  let version = 1;
  const hashedChunk = assetNames.find((name) => name.endsWith('.js'));
  let offline = false;
  const network = (url) => {
    if (offline || url.includes('/offline-image')) throw new TypeError('offline');
    return new sandbox.MockResponse(`${url}#v${version}`);
  };
  const sandbox = createServiceWorkerSandbox(sw, { network: (url) => network(url) });
  await sandbox.dispatchLifecycle('install');
  await sandbox.dispatchLifecycle('activate');

  // Hashed build output: cache-first, served from the precache without network.
  sandbox.fetchLog.length = 0;
  const chunk = await sandbox.dispatchFetch(`/${hashedChunk}`);
  assert.ok(chunk.intercepted, 'hashed chunk must be handled by the service worker');
  assert.equal(sandbox.fetchLog.length, 0, 'hashed chunk must be served cache-first');

  // Non-hashed public image: stale-while-revalidate.
  const imagePath = '/assets/scene-cat-temple.webp';
  const first = await sandbox.dispatchFetch(imagePath);
  assert.match(first.response.body, /#v1$/);
  version = 2;
  const stale = await sandbox.dispatchFetch(imagePath);
  assert.match(stale.response.body, /#v1$/, 'cached copy is returned immediately');
  const fresh = await sandbox.dispatchFetch(imagePath);
  assert.match(fresh.response.body, /#v2$/, 'background revalidation must replace a changed public image');

  // A same-named public file must never be treated as content-addressed.
  sandbox.fetchLog.length = 0;
  await sandbox.dispatchFetch('/assets/sm/hangzhou-tea.webp');
  await sandbox.dispatchFetch('/assets/sm/hangzhou-tea.webp');
  assert.equal(sandbox.fetchLog.length, 2, 'every public image request revalidates in the background');

  // Bounded image cache: oldest entries are evicted.
  for (let index = 0; index < 75; index += 1) await sandbox.dispatchFetch(`/assets/generated-${index}.webp`);
  const imageCacheName = [...sandbox.stores.keys()].find((name) => name.includes('images'));
  const imageKeys = await sandbox.stores.get(imageCacheName).keys();
  assert.equal(imageKeys.length, 60, 'image cache must be capped');
  assert.ok(imageKeys.some((key) => key.url.endsWith('/generated-74.webp')));
  assert.ok(!imageKeys.some((key) => key.url.endsWith('/generated-0.webp')), 'least recently written image is evicted first');

  // Offline with no cached copy: network error, not a cached HTML page.
  const offlineImage = await sandbox.dispatchFetch('/assets/offline-image.webp');
  assert.equal(offlineImage.response.type, 'error');

  // index.html（导航）：联网时每次都走网络，新版本马上生效；只在离线时用上次的副本兜底。
  version = 3;
  const nav1 = await sandbox.dispatchFetch('/', { mode: 'navigate' });
  assert.match(nav1.response.body, /#v3$/);
  version = 4;
  const nav2 = await sandbox.dispatchFetch('/', { mode: 'navigate' });
  assert.match(nav2.response.body, /#v4$/, 'index.html must be network-first so a new release is picked up');
  offline = true;
  const navOffline = await sandbox.dispatchFetch('/trip/x', { mode: 'navigate' });
  assert.match(navOffline.response.body, /#v4$/, 'offline navigation falls back to the last shell');
  offline = false;

  // 路书数据：网络优先并存一份；离线时返回存的那份（行程和地址离线可看）。
  version = 5;
  const book = await sandbox.dispatchFetch('/api/routebooks/rb1');
  assert.ok(book.intercepted);
  assert.match(book.response.body, /#v5$/);
  version = 6;
  assert.match((await sandbox.dispatchFetch('/api/routebooks/rb1')).response.body, /#v6$/, 'routebook data is network-first');
  offline = true;
  assert.match((await sandbox.dispatchFetch('/api/routebooks/rb1')).response.body, /#v6$/, 'offline routebook comes from the data cache');
  assert.match(
    (await sandbox.dispatchFetch('/api/share/s1').catch(() => ({ response: { body: 'miss' } }))).response.body,
    /miss/,
    'uncached share stays a network error offline'
  );
  offline = false;
  const dataCacheName = [...sandbox.stores.keys()].find((name) => name.includes('routebook-data'));
  assert.ok(dataCacheName, 'routebook data has its own cache');
  const dataKeys = (await sandbox.stores.get(dataCacheName).keys()).map((key) => new URL(key.url).pathname);
  assert.ok(
    dataKeys.every((path) => /^\/api\/(routebooks\/[^/]+(\/enrichment)?|share\/[^/]+)$/.test(path)),
    `data cache holds only routebook data: ${dataKeys}`
  );
  for (const name of sandbox.stores.keys()) {
    const keys = (await sandbox.stores.get(name).keys()).map((key) => new URL(key.url).pathname);
    if (!name.includes('shell')) assert.ok(!keys.includes('/') && !keys.includes('/index.html'), `index.html must not sit in ${name}`);
  }

  // Other API, cross-origin and non-GET requests are never intercepted.
  for (const path of ['/api/auth/me', '/api/routebooks', '/api/routebooks/x/versions', '/api/ops/enrichment', '/api/routebooks/x/enrichment/report']) {
    assert.equal((await sandbox.dispatchFetch(path)).intercepted, false, `${path} must not be cached`);
  }
  assert.equal((await sandbox.dispatchFetch('/api/routebooks/x', { method: 'POST' })).intercepted, false);
  // /admin is excluded entirely: navigation, assets, nothing is intercepted or written to any cache.
  const shellCacheName = [...sandbox.stores.keys()].find((name) => name.includes('shell'));
  const shellBefore = shellCacheName ? (await sandbox.stores.get(shellCacheName).keys()).map((k) => k.url).join() : '';
  for (const [path, mode] of [
    ['/admin', 'navigate'],
    ['/admin/', 'navigate'],
    ['/admin/config', 'navigate'],
    ['/admin/assets/index-abc.js', 'no-cors']
  ]) {
    assert.equal((await sandbox.dispatchFetch(path, { mode })).intercepted, false, `${path} must not be handled by the user service worker`);
  }
  const shellAfter = shellCacheName ? (await sandbox.stores.get(shellCacheName).keys()).map((k) => k.url).join() : '';
  assert.equal(shellAfter, shellBefore, 'admin HTML never replaces the user App Shell');
  assert.equal((await sandbox.dispatchFetch('https://tiles.example.com/1/2/3.png')).intercepted, false);
  assert.equal((await sandbox.dispatchFetch('/assets/scene-cat-temple.webp', { method: 'POST' })).intercepted, false);

  // A new build version drops old shell/static caches but keeps the image cache.
  sandbox.stores.set('trusted-routebook-pwa-static-build-0000000000000000', { keys: async () => [] });
  await sandbox.dispatchLifecycle('activate');
  assert.ok(![...sandbox.stores.keys()].includes('trusted-routebook-pwa-static-build-0000000000000000'));
  assert.ok(sandbox.stores.has(imageCacheName), 'image cache survives activation');
}

console.log(
  `PWA 构建回归通过：已预缓存 ${assetNames.length} 个 hashed JS/CSS 产物；缓存策略行为（hash 产物缓存优先、public 图片 SWR+上限、路书数据网络优先+离线兜底、index.html 网络优先、其他 API 不拦截、/admin 完全不拦截）通过`
);

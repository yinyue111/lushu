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
  const network = (url) => {
    if (url.includes('/offline-image')) throw new TypeError('offline');
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
  const offline = await sandbox.dispatchFetch('/assets/offline-image.webp');
  assert.equal(offline.response.type, 'error');

  // API, cross-origin and non-GET requests are never intercepted.
  assert.equal((await sandbox.dispatchFetch('/api/routebooks/x')).intercepted, false);
  assert.equal((await sandbox.dispatchFetch('https://tiles.example.com/1/2/3.png')).intercepted, false);
  assert.equal((await sandbox.dispatchFetch('/assets/scene-cat-temple.webp', { method: 'POST' })).intercepted, false);

  // A new build version drops old shell/static caches but keeps the image cache.
  sandbox.stores.set('trusted-routebook-pwa-static-build-0000000000000000', { keys: async () => [] });
  await sandbox.dispatchLifecycle('activate');
  assert.ok(![...sandbox.stores.keys()].includes('trusted-routebook-pwa-static-build-0000000000000000'));
  assert.ok(sandbox.stores.has(imageCacheName), 'image cache survives activation');
}

console.log(`PWA 构建回归通过：已预缓存 ${assetNames.length} 个 hashed JS/CSS 产物；缓存策略行为（hash 产物缓存优先、public 图片 SWR+上限、API 不拦截）通过`);

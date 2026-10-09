import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

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
assert.match(sw, /names\s*\.filter\(\(name\) => name\.startsWith\(CACHE_PREFIX\) && !CURRENT_CACHES\.has\(name\)\)/);
assert.match(sw, /caches\.match\(APP_SHELL_URL\)/, 'navigation must retain an offline App Shell fallback');

console.log(`PWA 构建回归通过：已预缓存 ${assetNames.length} 个 hashed JS/CSS 产物`);

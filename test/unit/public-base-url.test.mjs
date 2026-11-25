import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { publicBaseUrlHtmlPlugin, resolveBuildPublicBaseUrl } from '../../scripts/lib/public-base-url.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

test('PUBLIC_BASE_URL build check: four required scenarios + CI=true independence', () => {
  // 1) REQUIRE_PUBLIC_BASE_URL=1 without PUBLIC_BASE_URL -> fails
  assert.throws(() => resolveBuildPublicBaseUrl({ REQUIRE_PUBLIC_BASE_URL: '1' }), /REQUIRE_PUBLIC_BASE_URL=1/);
  assert.throws(() => resolveBuildPublicBaseUrl({ REQUIRE_PUBLIC_BASE_URL: '1', PUBLIC_BASE_URL: '   ' }), /REQUIRE_PUBLIC_BASE_URL=1/);

  // 2) REQUIRE_PUBLIC_BASE_URL=1 with http or localhost/127.0.0.1 -> fails
  assert.throws(() => resolveBuildPublicBaseUrl({ REQUIRE_PUBLIC_BASE_URL: '1', PUBLIC_BASE_URL: 'http://localhost:5173' }), /https/);
  assert.throws(() => resolveBuildPublicBaseUrl({ REQUIRE_PUBLIC_BASE_URL: '1', PUBLIC_BASE_URL: 'https://localhost:5173' }), /localhost/);
  assert.throws(() => resolveBuildPublicBaseUrl({ REQUIRE_PUBLIC_BASE_URL: '1', PUBLIC_BASE_URL: 'https://127.0.0.1:3080' }), /localhost|loopback/);
  assert.throws(() => resolveBuildPublicBaseUrl({ REQUIRE_PUBLIC_BASE_URL: '1', PUBLIC_BASE_URL: 'http://lushu.aiwuq.cn' }), /https/);

  // 3) REQUIRE_PUBLIC_BASE_URL=1 with https://lushu.aiwuq.cn -> succeeds and injects og:url + canonical
  assert.equal(resolveBuildPublicBaseUrl({ REQUIRE_PUBLIC_BASE_URL: '1', PUBLIC_BASE_URL: 'https://lushu.aiwuq.cn/' }), 'https://lushu.aiwuq.cn');
  const plugin = publicBaseUrlHtmlPlugin({ REQUIRE_PUBLIC_BASE_URL: '1', PUBLIC_BASE_URL: 'https://lushu.aiwuq.cn' });
  plugin.configResolved();
  const rawHtml = readFileSync(`${ROOT}/index.html`, 'utf8');
  const transformed = plugin.transformIndexHtml(rawHtml);
  assert.match(transformed, /<meta property="og:url" content="https:\/\/lushu\.aiwuq\.cn\/"\s*\/>/);
  assert.match(transformed, /<link rel="canonical" href="https:\/\/lushu\.aiwuq\.cn\/"\s*\/>/);
  assert.match(transformed, /<meta property="og:image" content="https:\/\/lushu\.aiwuq\.cn\/assets\/city-aerial\.webp\?v=20260731"\s*\/>/);

  // 4) REQUIRE_PUBLIC_BASE_URL not set (including CI=true) -> succeeds with default fallback
  assert.equal(resolveBuildPublicBaseUrl({}), 'https://lushu.aiwuq.cn');
  assert.equal(resolveBuildPublicBaseUrl({ CI: 'true' }), 'https://lushu.aiwuq.cn');
});

test('Dockerfile and image.yml wire PUBLIC_BASE_URL and REQUIRE_PUBLIC_BASE_URL=1 in build stage', () => {
  const dockerfile = readFileSync(`${ROOT}/Dockerfile`, 'utf8');
  assert.match(dockerfile, /ARG PUBLIC_BASE_URL/);
  assert.match(dockerfile, /REQUIRE_PUBLIC_BASE_URL=1/);
  const workflow = readFileSync(`${ROOT}/.github/workflows/image.yml`, 'utf8');
  assert.match(workflow, /PUBLIC_BASE_URL=\$\{\{\s*vars\.PUBLIC_BASE_URL\s*\}\}/);
});

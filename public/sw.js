const CACHE_PREFIX = 'trusted-routebook-pwa-';
// 生产构建会由 vite.config.js 把两个占位符替换为内容修订号与完整的 hashed 产物清单。
// 开发环境直接服务该文件时保持有效 JS，仅缓存固定 App Shell。
const CACHE_VERSION = '__PWA_CACHE_VERSION__';
const BUILD_PRECACHE_MANIFEST = /* __PWA_PRECACHE_MANIFEST__ */ [];
const SHELL_CACHE = `${CACHE_PREFIX}shell-${CACHE_VERSION}`;
const STATIC_CACHE = `${CACHE_PREFIX}static-${CACHE_VERSION}`;
const CURRENT_CACHES = new Set([SHELL_CACHE, STATIC_CACHE]);
const SCOPE_URL = new URL(self.registration.scope);
const SCOPE_PATH = SCOPE_URL.pathname.endsWith('/') ? SCOPE_URL.pathname : `${SCOPE_URL.pathname}/`;
const APP_SHELL_URL = new URL('./', SCOPE_URL).href;
const PRECACHE_URLS = [
  APP_SHELL_URL,
  new URL('manifest.webmanifest', SCOPE_URL).href,
  new URL('icons/routebook-192.svg', SCOPE_URL).href,
  new URL('icons/routebook-512.svg', SCOPE_URL).href,
  ...BUILD_PRECACHE_MANIFEST.map((entry) => new URL(entry.url, SCOPE_URL).href)
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // 构建入口缓存不完整时让 install 失败，保留旧 SW，避免冷启动只剩 HTML。
    await Promise.all(PRECACHE_URLS.map(async (url) => {
      const response = await fetch(new Request(url, { cache: 'reload', credentials: 'same-origin' }));
      if (!response.ok || response.type !== 'basic') throw new Error(`Precache failed: ${url}`);
      await cache.put(url, response);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith(CACHE_PREFIX) && !CURRENT_CACHES.has(name))
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || isApiRequest(url)) return;

  if (request.mode === 'navigate') {
    event.respondWith(navigationResponse(request));
    return;
  }
  if (isBuildStaticAsset(url)) event.respondWith(staticAssetResponse(request));
});

async function navigationResponse(request) {
  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put(APP_SHELL_URL, response.clone());
    }
    return response;
  } catch {
    return (await caches.match(APP_SHELL_URL)) || Response.error();
  }
}

async function staticAssetResponse(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && response.type === 'basic') {
    const cache = await caches.open(STATIC_CACHE);
    await cache.put(request, response.clone());
  }
  return response;
}

function isApiRequest(url) {
  return url.pathname === '/api' ||
    url.pathname.startsWith('/api/') ||
    url.pathname === `${SCOPE_PATH}api` ||
    url.pathname.startsWith(`${SCOPE_PATH}api/`);
}

function isBuildStaticAsset(url) {
  return url.pathname.startsWith(`${SCOPE_PATH}assets/`) ||
    url.pathname.startsWith(`${SCOPE_PATH}icons/`) ||
    url.pathname === `${SCOPE_PATH}manifest.webmanifest`;
}

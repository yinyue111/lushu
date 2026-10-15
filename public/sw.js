const CACHE_PREFIX = 'trusted-routebook-pwa-';
// 生产构建会由 vite.config.js 把两个占位符替换为内容修订号与完整的 hashed 产物清单。
// 开发环境直接服务该文件时保持有效 JS，仅缓存固定 App Shell。
const CACHE_VERSION = '__PWA_CACHE_VERSION__';
const BUILD_PRECACHE_MANIFEST = /* __PWA_PRECACHE_MANIFEST__ */ [];
// 其他带 hash 的构建产物（字体、被 JS 引用的图片等）：内容寻址，可永久缓存优先。
const BUILD_HASHED_ASSETS = /* __PWA_HASHED_ASSETS__ */ [];
const SHELL_CACHE = `${CACHE_PREFIX}shell-${CACHE_VERSION}`;
const STATIC_CACHE = `${CACHE_PREFIX}static-${CACHE_VERSION}`;
// public/ 下的图片文件名不带 hash，替换图片不会改变构建版本号；因此单独一个
// 跨版本保留的缓存，用 stale-while-revalidate 保持新鲜，并按条目数封顶。
const IMAGE_CACHE = `${CACHE_PREFIX}images-v1`;
const IMAGE_CACHE_MAX_ENTRIES = 60;
// 生成好的路书数据（行程、地址）：联网时总是走网络并顺手存一份，离线时用存的那份，行中断网也能看。
// 只存路书本身 / 分享页 / 补全结果三类 GET，其他 API 一律不经过缓存；退出登录时页面会清掉这个缓存。
const DATA_CACHE = `${CACHE_PREFIX}routebook-data-v1`;
const DATA_CACHE_MAX_ENTRIES = 40;
const CURRENT_CACHES = new Set([SHELL_CACHE, STATIC_CACHE, IMAGE_CACHE, DATA_CACHE]);
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
const HASHED_BUILD_PATHS = new Set(
  [...BUILD_PRECACHE_MANIFEST.map((entry) => entry.url), ...BUILD_HASHED_ASSETS].map((url) => new URL(url, SCOPE_URL).pathname)
);

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
  if (url.origin !== self.location.origin) return;
  // The admin console is a separate app with no-store HTML: never cache it, never let it become the user shell.
  if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) return;
  if (isRoutebookDataRequest(url)) {
    event.respondWith(routebookDataResponse(request));
    return;
  }
  if (isApiRequest(url)) return;

  if (request.mode === 'navigate') {
    event.respondWith(navigationResponse(request));
    return;
  }
  if (HASHED_BUILD_PATHS.has(url.pathname)) {
    event.respondWith(hashedAssetResponse(request));
    return;
  }
  if (isPublicStaticFile(url)) event.respondWith(staleWhileRevalidate(event, request));
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
    return (await caches.match(APP_SHELL_URL)) || offlineFallbackResponse();
  }
}

// Cold start with no cached shell: a tiny same-origin page instead of the browser's error screen.
// The sentence must equal NETWORK_ERROR_TEXT in src/lib/networkCopy.js (enforced by a unit test).
const OFFLINE_FALLBACK_TEXT = '网络不太稳，没连上。检查网络后再试。';
function offlineFallbackResponse() {
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>可信路书</title></head><body style="margin:0;font:16px/1.6 system-ui,sans-serif;color:#1f1d1a;background:#faf7f2;display:grid;place-items:center;min-height:100vh"><main style="max-width:22rem;padding:1.5rem;text-align:center"><h1 style="font-size:1.25rem;margin:0 0 .5rem">没连上网络</h1><p style="margin:0 0 1rem">${OFFLINE_FALLBACK_TEXT}</p><button type="button" onclick="location.reload()" style="min-height:44px;padding:0 1.25rem;border:0;border-radius:999px;background:#bd3f2a;color:#fff;font:inherit;font-weight:700">再试一次</button></main></body></html>`;
  return new Response(html, { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

async function routebookDataResponse(request) {
  const cache = await caches.open(DATA_CACHE);
  try {
    const response = await fetch(request);
    if (isCacheableResponse(response)) {
      await cache.put(request, response.clone());
      await trimCache(cache, DATA_CACHE_MAX_ENTRIES);
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw error;
  }
}

function isRoutebookDataRequest(url) {
  const path = url.pathname.startsWith(SCOPE_PATH) ? `/${url.pathname.slice(SCOPE_PATH.length)}` : url.pathname;
  return /^\/api\/routebooks\/[^/]+(?:\/enrichment)?$/.test(path) || /^\/api\/share\/[^/]+$/.test(path);
}

// 内容寻址的构建产物：URL 变了内容才会变，缓存优先永远安全。
async function hashedAssetResponse(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (isCacheableResponse(response)) {
    const cache = await caches.open(STATIC_CACHE);
    await cache.put(request, response.clone());
  }
  return response;
}

// 不带 hash 的 public 静态文件（/assets 图片、图标、manifest）：先返回缓存，
// 同时后台更新；离线时用缓存兜底。
async function staleWhileRevalidate(event, request) {
  const cache = await caches.open(IMAGE_CACHE);
  const cached = (await cache.match(request)) || (await caches.match(request));
  const network = fetch(request)
    .then(async (response) => {
      if (isCacheableResponse(response)) {
        await cache.put(request, response.clone());
        await trimCache(cache, IMAGE_CACHE_MAX_ENTRIES);
      }
      return response;
    })
    .catch(() => null);
  if (cached) {
    event.waitUntil(network);
    return cached;
  }
  return (await network) || Response.error();
}

// Cache.put 会把已存在的条目移到末尾，所以 keys() 的顺序近似“最近写入”，删最旧的。
async function trimCache(cache, maxEntries) {
  const keys = await cache.keys();
  const excess = keys.length - maxEntries;
  for (let index = 0; index < excess; index += 1) await cache.delete(keys[index]);
}

function isCacheableResponse(response) {
  return Boolean(response) && response.ok && response.status === 200 && response.type === 'basic';
}

function isApiRequest(url) {
  return url.pathname === '/api' ||
    url.pathname.startsWith('/api/') ||
    url.pathname === `${SCOPE_PATH}api` ||
    url.pathname.startsWith(`${SCOPE_PATH}api/`);
}

function isPublicStaticFile(url) {
  return url.pathname.startsWith(`${SCOPE_PATH}assets/`) ||
    url.pathname.startsWith(`${SCOPE_PATH}icons/`) ||
    url.pathname === `${SCOPE_PATH}manifest.webmanifest`;
}

// Static file serving (dist/) and share/review landing pages with og meta.
import { readFile, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { brotliCompress, constants as zlibConstants, gzip } from 'node:zlib';
import { extname, join, resolve, sep } from 'node:path';
import { DIST_DIR, MIME_TYPES, PUBLIC_BASE_URL, PROJECT_ROOT } from '../config/index.mjs';
import { STATIC_SECURITY_HEADERS, sendJson, securityHeaders } from './response.mjs';
import { sanitizePublicId, clampNumber, normalizeCityName, truncateString } from '../lib/util.mjs';
import { cityStories, defaultCityImage } from '../../src/lib/content.js';
import { getSavedReview } from '../storage/records.mjs';
import { getResolvableRoutebook } from '../routebooks/normalize.mjs';
import { isPublicRoutebook } from '../routebooks/views.mjs';
import { aigcMetadata } from '../../src/lib/aigc.js';
import { reviewIsStillPublic } from '../reviews/reviews.mjs';
import { shouldTrustProxyHeaders } from '../auth/request-access.mjs';

const brotliCompressAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

// L8: static files are served from an in-memory cache (validated by mtime/size via
// async stat) with lazily computed brotli/gzip variants, ETags and 304s.
// Only content-hashed build assets are cached as immutable.
const STATIC_CACHE_MAX_FILE_BYTES = 2 * 1024 * 1024;
const STATIC_CACHE_MAX_TOTAL_BYTES = 48 * 1024 * 1024;
const STATIC_COMPRESS_MIN_BYTES = 1024;
const COMPRESSIBLE_EXTENSIONS = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt', '.xml', '.webmanifest', '.map']);
const HASHED_ASSET_PATTERN = /-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/; // Vite content hash
const staticFileCache = new Map();
let staticCacheBytes = 0;

function staticCacheControl(filePath) {
  if (filePath.endsWith('index.html') || filePath.endsWith('/sw.js')) return 'no-cache';
  return HASHED_ASSET_PATTERN.test(filePath) ? 'public, max-age=31536000, immutable' : 'public, max-age=3600';
}

function preferredEncoding(req, ext, size) {
  if (!COMPRESSIBLE_EXTENSIONS.has(ext) || size < STATIC_COMPRESS_MIN_BYTES) return null;
  const accepted = String(req.headers['accept-encoding'] ?? '').toLowerCase();
  const allows = (name) =>
    accepted.split(',').some((part) => {
      const [token, ...params] = part.trim().split(';');
      if (token.trim() !== name) return false;
      const q = params.map((param) => param.trim()).find((param) => param.startsWith('q='));
      return !q || Number(q.slice(2)) > 0;
    });
  if (allows('br')) return 'br';
  if (allows('gzip')) return 'gzip';
  return null;
}

function rememberStaticFile(filePath, entry) {
  const previous = staticFileCache.get(filePath);
  if (previous) staticCacheBytes -= previous.bytes;
  staticFileCache.delete(filePath);
  if (entry.bytes > STATIC_CACHE_MAX_FILE_BYTES) return;
  staticFileCache.set(filePath, entry);
  staticCacheBytes += entry.bytes;
  while (staticCacheBytes > STATIC_CACHE_MAX_TOTAL_BYTES && staticFileCache.size > 0) {
    const [oldestPath, oldest] = staticFileCache.entries().next().value;
    staticFileCache.delete(oldestPath);
    staticCacheBytes -= oldest.bytes;
  }
}

async function loadStaticFile(filePath, stats) {
  const cached = staticFileCache.get(filePath);
  if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) return cached;
  const body = await readFile(filePath);
  const entry = {
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    body,
    etag: `W/"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`,
    variants: new Map(),
    bytes: body.byteLength
  };
  rememberStaticFile(filePath, entry);
  return entry;
}

async function encodedBody(entry, filePath, encoding) {
  if (!encoding) return entry.body;
  const existing = entry.variants.get(encoding);
  if (existing) return existing;
  const compressed =
    encoding === 'br'
      ? await brotliCompressAsync(entry.body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 9 } })
      : await gzipAsync(entry.body, { level: 9 });
  entry.variants.set(encoding, compressed);
  if (staticFileCache.get(filePath) === entry) {
    entry.bytes += compressed.byteLength;
    staticCacheBytes += compressed.byteLength;
  }
  return compressed;
}

async function statOrNull(path) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

export async function sendStatic(req, res) {
  if (!(await statOrNull(DIST_DIR))) {
    return sendJson(res, 503, {
      error: 'dist 不存在，请先运行 npm run build',
      code: 'DIST_MISSING'
    });
  }

  let decodedPath = '/';
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    return sendJson(res, 400, { error: '请求路径不合法', code: 'BAD_PATH' });
  }
  const normalizedPath = decodedPath === '/' ? '/index.html' : decodedPath;
  const requestedPath = resolve(DIST_DIR, `.${normalizedPath}`);
  const rootPath = resolve(DIST_DIR);
  const isInsideDist = requestedPath === rootPath || requestedPath.startsWith(`${rootPath}${sep}`);
  if (!isInsideDist) {
    return sendJson(res, 404, { error: '文件不存在', code: 'NOT_FOUND' });
  }
  const requestedStats = await statOrNull(requestedPath);
  if (!requestedStats && extname(normalizedPath) !== '') {
    return sendJson(res, 404, { error: '文件不存在', code: 'NOT_FOUND' });
  }
  const filePath = requestedStats ? requestedPath : join(DIST_DIR, 'index.html');
  const fileStats = requestedStats ?? (await statOrNull(filePath));
  if (!fileStats?.isFile()) {
    return sendJson(res, 404, { error: '文件不存在', code: 'NOT_FOUND' });
  }
  const ext = extname(filePath);

  try {
    const entry = await loadStaticFile(filePath, fileStats);
    const encoding = preferredEncoding(req, ext, entry.size);
    const headers = {
      ...STATIC_SECURITY_HEADERS,
      'content-type': MIME_TYPES[ext] ?? 'application/octet-stream',
      'cache-control': staticCacheControl(filePath),
      etag: entry.etag,
      ...(COMPRESSIBLE_EXTENSIONS.has(ext) ? { vary: 'accept-encoding' } : {})
    };
    const ifNoneMatch = String(req.headers['if-none-match'] ?? '');
    if (
      ifNoneMatch &&
      ifNoneMatch
        .split(',')
        .map((tag) => tag.trim())
        .includes(entry.etag)
    ) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    const body = await encodedBody(entry, filePath, encoding);
    res.writeHead(200, {
      ...headers,
      ...(encoding ? { 'content-encoding': encoding } : {}),
      'content-length': body.byteLength
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    sendJson(res, 404, { error: '文件不存在', code: 'NOT_FOUND' });
  }
}

// rank15①：/share/:id 与 /review/:id 的 H5 落地页注入 og meta（微信/朋友圈等
// 分享卡片抓不到 SPA 运行时标题）。读取失败或路书/回顾非公开时原样回退 index.html。
export function matchShareLandingPath(req) {
  if (req.method !== 'GET') return null;
  let pathname = '';
  try {
    pathname = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).pathname;
  } catch {
    return null;
  }
  const match = /^\/(share|review)\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  let decoded = '';
  try {
    decoded = decodeURIComponent(match[2]);
  } catch {
    return null;
  }
  const id = sanitizePublicId(decoded);
  return id ? { kind: match[1], id } : null;
}

// 注入值统一做 HTML 实体转义，防止路书标题/摘要携带的 <script> 等内容注入页面。
function escapeHtmlText(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('`', '&#96;');
}

async function buildShareLandingMeta(target) {
  try {
    if (target.kind === 'share') {
      const routebook = await getResolvableRoutebook(target.id);
      if (!routebook || !isPublicRoutebook(routebook)) return null;
      const title = truncateString(routebook.title, 80) || 'AI 可信路书';
      const city = routebook.city ? normalizeCityName(routebook.city) : '';
      const stops = Array.isArray(routebook.stops) ? routebook.stops : [];
      return {
        title: `${title}｜AI 可信路书`,
        description: truncateString(routebook.summary, 160) || `${city ? `${city}的` : ''}可执行、可验证的分日路书。`,
        image: cityStories[city]?.image ?? defaultCityImage,
        path: `/share/${encodeURIComponent(target.id)}`,
        aigc: aigcMetadata(routebook),
        // Pre-rendered text for crawlers without JS (inside <noscript>, so users never see a flash).
        prerender: {
          heading: title,
          lines: stops.slice(0, 20).map((stop) => [truncateString(stop?.day, 24), truncateString(stop?.name, 60)].filter(Boolean).join(' · '))
        }
      };
    }
    const review = await getSavedReview(target.id);
    if (!review || !isPublicRoutebook(review.routebook) || !(await reviewIsStillPublic(review))) return null;
    const routeTitle = truncateString(review.routebook?.title, 80) || 'AI 可信路书';
    const reviewCity = review.routebook?.city ? normalizeCityName(review.routebook.city) : '';
    const stats = review.stats && typeof review.stats === 'object' ? review.stats : {};
    return {
      title: `${routeTitle}｜旅行回顾`,
      description: truncateString(
        `真实打卡 ${clampNumber(stats.checkinCount, 0, 100000, 0)} 次，主线完成率 ${clampNumber(stats.completionRate, 0, 100, 0)}%，来自 AI 可信路书的可验证行程回顾。`,
        200
      ),
      image: cityStories[reviewCity]?.image ?? defaultCityImage,
      path: `/review/${encodeURIComponent(target.id)}`,
      aigc: aigcMetadata(review.routebook),
      prerender: { heading: `${routeTitle}｜旅行回顾`, lines: [] }
    };
  } catch {
    return null;
  }
}

function injectShareLandingMeta(html, meta) {
  const safeTitle = escapeHtmlText(meta.title);
  const safeDescription = escapeHtmlText(meta.description);
  const safeImage = escapeHtmlText(meta.image ?? '');
  const metaTags = [
    `<meta property="og:title" content="${safeTitle}">`,
    `<meta property="og:description" content="${safeDescription}">`,
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="AI 可信路书">',
    ...(safeImage
      ? [
          `<meta property="og:image" content="${safeImage}">`,
          '<meta name="twitter:card" content="summary_large_image">',
          `<meta name="twitter:image" content="${safeImage}">`
        ]
      : ['<meta name="twitter:card" content="summary">']),
    `<meta name="description" content="${safeDescription}">`,
    '<meta property="og:locale" content="zh_CN">',
    ...(meta.url ? [`<meta property="og:url" content="${escapeHtmlText(meta.url)}">`, `<link rel="canonical" href="${escapeHtmlText(meta.url)}">`] : []),
    // Implicit AIGC label for machine readers (see src/lib/aigc.js).
    ...(meta.aigc?.generated ? [`<meta name="aigc" content="${escapeHtmlText(JSON.stringify(meta.aigc))}">`] : [])
  ].join('\n    ');
  // 用函数返回替换串：字符串形态的第二参会展开 $&/$` 等模板序列，
  // 标题里出现这些字符时会把原 HTML 片段拼进注入结果。
  let output = html.replace(/<title>[\s\S]*?<\/title>/i, () => `<title>${safeTitle}</title>`);
  if (output.includes('</head>')) {
    output = output.replace('</head>', () => `    ${metaTags}\n  </head>`);
  }
  if (meta.prerender && output.includes('</body>')) {
    const items = (meta.prerender.lines ?? []).map((line) => `<li>${escapeHtmlText(line)}</li>`).join('');
    const label = meta.aigc?.generated ? `<p>${escapeHtmlText(meta.aigc.label)}</p>` : '';
    const block = `<noscript><article><h1>${escapeHtmlText(meta.prerender.heading)}</h1>${label}<p>${safeDescription}</p>${items ? `<ol>${items}</ol>` : ''}</article></noscript>`;
    output = output.replace('</body>', () => `  ${block}\n  </body>`);
  }
  return output;
}

// L4: prefer the configured PUBLIC_BASE_URL. Otherwise only trust X-Forwarded-Proto
// from a trusted proxy and only accept a syntactically valid Host header, so a
// spoofed Host cannot inject arbitrary origins into og:image.
const VALID_HOST_HEADER =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

function shareLandingOrigin(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const host = String(req.headers.host ?? '').trim();
  if (!host || host.length > 255 || !VALID_HOST_HEADER.test(host)) return '';
  const forwardedProto = shouldTrustProxyHeaders(req)
    ? String(req.headers['x-forwarded-proto'] ?? '')
        .split(',')[0]
        .trim()
        .toLowerCase()
    : '';
  const proto = forwardedProto === 'https' || forwardedProto === 'http' ? forwardedProto : req.socket?.encrypted ? 'https' : 'http';
  return `${proto}://${host}`;
}

// 返回 true 表示已响应；返回 false 让调用方回退到 vite/静态托管原样返回 index.html。
export async function serveShareLandingHtml(req, res, target, vite = null) {
  const meta = await buildShareLandingMeta(target);
  if (!meta) return false;
  // og:image 需要绝对 URL（微信/QQ 等抓取器不解析相对路径）；以请求来源组装 origin。
  const origin = shareLandingOrigin(req);
  if (meta.image?.startsWith('/') && origin) meta.image = `${origin}${meta.image}`;
  if (origin && meta.path) meta.url = `${origin}${meta.path}`;
  let html = '';
  try {
    if (vite) {
      html = await readFile(join(PROJECT_ROOT, 'index.html'), 'utf8');
      html = await vite.transformIndexHtml(req.url ?? `/${target.kind}/${target.id}`, html);
    } else {
      html = await readFile(join(DIST_DIR, 'index.html'), 'utf8');
    }
  } catch {
    return false;
  }
  const body = injectShareLandingMeta(html, meta);
  res.writeHead(200, {
    // dev 下 vite 会注入内联脚本（react-refresh preamble），不能带静态 CSP。
    ...(vite ? securityHeaders() : STATIC_SECURITY_HEADERS),
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-cache'
  });
  res.end(body);
  return true;
}

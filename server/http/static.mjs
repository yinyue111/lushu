// Static file serving (dist/) and share/review landing pages with og meta.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { DIST_DIR, MIME_TYPES, PUBLIC_BASE_URL, PROJECT_ROOT } from '../config/index.mjs';
import { STATIC_SECURITY_HEADERS, sendJson, securityHeaders } from './response.mjs';
import { sanitizePublicId, clampNumber, normalizeCityName, truncateString } from '../lib/util.mjs';
import { cityStories, defaultCityImage } from '../../src/lib/content.js';
import { getSavedReview } from '../storage/records.mjs';
import { getResolvableRoutebook } from '../routebooks/normalize.mjs';
import { isPublicRoutebook } from '../routebooks/views.mjs';
import { reviewIsStillPublic } from '../reviews/reviews.mjs';
import { shouldTrustProxyHeaders } from '../auth/request-access.mjs';

export async function sendStatic(req, res) {
  if (!existsSync(DIST_DIR)) {
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
  const missingAsset = !existsSync(requestedPath) && extname(normalizedPath) !== '';
  if (missingAsset) {
    return sendJson(res, 404, { error: '文件不存在', code: 'NOT_FOUND' });
  }
  const filePath = existsSync(requestedPath) ? requestedPath : join(DIST_DIR, 'index.html');
  const ext = extname(filePath);

  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      ...STATIC_SECURITY_HEADERS,
      'content-type': MIME_TYPES[ext] ?? 'application/octet-stream',
      'cache-control': filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable'
    });
    res.end(body);
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
export function escapeHtmlText(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('`', '&#96;');
}

export async function buildShareLandingMeta(target) {
  try {
    if (target.kind === 'share') {
      const routebook = await getResolvableRoutebook(target.id);
      if (!routebook || !isPublicRoutebook(routebook)) return null;
      const title = truncateString(routebook.title, 80) || 'AI 可信路书';
      const city = routebook.city ? normalizeCityName(routebook.city) : '';
      return {
        title: `${title}｜AI 可信路书`,
        description: truncateString(routebook.summary, 160) || `${city ? `${city}的` : ''}可执行、可验证的分日路书。`,
        image: cityStories[city]?.image ?? defaultCityImage
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
      image: cityStories[reviewCity]?.image ?? defaultCityImage
    };
  } catch {
    return null;
  }
}

export function injectShareLandingMeta(html, meta) {
  const safeTitle = escapeHtmlText(meta.title);
  const safeDescription = escapeHtmlText(meta.description);
  const safeImage = escapeHtmlText(meta.image ?? '');
  const metaTags = [
    `<meta property="og:title" content="${safeTitle}">`,
    `<meta property="og:description" content="${safeDescription}">`,
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="AI 可信路书">',
    ...(safeImage ? [
      `<meta property="og:image" content="${safeImage}">`,
      '<meta name="twitter:card" content="summary_large_image">',
      `<meta name="twitter:image" content="${safeImage}">`
    ] : [
      '<meta name="twitter:card" content="summary">'
    ]),
    `<meta name="description" content="${safeDescription}">`
  ].join('\n    ');
  // 用函数返回替换串：字符串形态的第二参会展开 $&/$` 等模板序列，
  // 标题里出现这些字符时会把原 HTML 片段拼进注入结果。
  let output = html.replace(/<title>[\s\S]*?<\/title>/i, () => `<title>${safeTitle}</title>`);
  if (output.includes('</head>')) {
    output = output.replace('</head>', () => `    ${metaTags}\n  </head>`);
  }
  return output;
}

// L4: prefer the configured PUBLIC_BASE_URL. Otherwise only trust X-Forwarded-Proto
// from a trusted proxy and only accept a syntactically valid Host header, so a
// spoofed Host cannot inject arbitrary origins into og:image.
export const VALID_HOST_HEADER = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

export function shareLandingOrigin(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const host = String(req.headers.host ?? '').trim();
  if (!host || host.length > 255 || !VALID_HOST_HEADER.test(host)) return '';
  const forwardedProto = shouldTrustProxyHeaders(req)
    ? String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase()
    : '';
  const proto = forwardedProto === 'https' || forwardedProto === 'http'
    ? forwardedProto
    : (req.socket?.encrypted ? 'https' : 'http');
  return `${proto}://${host}`;
}

// 返回 true 表示已响应；返回 false 让调用方回退到 vite/静态托管原样返回 index.html。
export async function serveShareLandingHtml(req, res, target, vite = null) {
  const meta = await buildShareLandingMeta(target);
  if (!meta) return false;
  // og:image 需要绝对 URL（微信/QQ 等抓取器不解析相对路径）；以请求来源组装 origin。
  if (meta.image?.startsWith('/')) {
    const origin = shareLandingOrigin(req);
    if (origin) meta.image = `${origin}${meta.image}`;
  }
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

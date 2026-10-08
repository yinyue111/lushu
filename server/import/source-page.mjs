// Imported guide pages: platform detection, HTML metadata/text extraction, scoring.
import { decodeHtmlEntities } from './html-text.mjs';
import { MAX_IMPORT_URLS, MAX_IMPORT_PAGE_BYTES, IMPORT_TIMEOUT_MS } from '../config/index.mjs';
import { clampNumber, createHttpError } from '../lib/util.mjs';
import { assertPublicHttpResponseUrl, fetchPublicPageResponse, getResponseHeader, assertPublicHttpUrl } from './ssrf.mjs';

const SOURCE_PLATFORMS = [
  {
    id: 'xiaohongshu',
    name: '小红书',
    hosts: ['xiaohongshu.com', 'xhslink.com'],
    baseScore: 72,
    note: 'UGC 种草内容强，需重点复核闭店、价格、排队和商业合作痕迹。'
  },
  {
    id: 'douyin',
    name: '抖音',
    hosts: ['douyin.com', 'iesdouyin.com'],
    baseScore: 68,
    note: '短视频时效强但上下文少，需复核发布时间、定位和是否为团购引流。'
  },
  {
    id: 'x',
    name: 'X',
    hosts: ['x.com', 'twitter.com', 't.co'],
    baseScore: 62,
    note: '适合发现即时反馈，但旅行攻略结构弱，需与地图和近期打卡交叉验证。'
  }
];

export function extractUrls(text) {
  const matches = String(text ?? '').match(/https?:\/\/[^\s"'<>，。；、)）]+/gi) ?? [];
  return [...new Set(matches.map((url) => url.replace(/[.,;!?]+$/, '')))].slice(0, MAX_IMPORT_URLS);
}

export function detectPlatform(url) {
  let hostname = '';
  try {
    hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return {
      id: 'invalid',
      name: '无效链接',
      baseScore: 20,
      note: '链接格式无法解析。'
    };
  }
  return (
    SOURCE_PLATFORMS.find((platform) => platform.hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`))) ?? {
      id: 'web',
      name: hostname,
      baseScore: 58,
      note: '普通公开网页，可信度取决于页面可访问性、发布时间和内容完整度。'
    }
  );
}

function extractMeta(html, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>|<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`,
    'i'
  );
  const match = html.match(pattern);
  return decodeHtmlEntities(match?.[1] ?? match?.[2] ?? '').trim();
}

function extractTitle(html) {
  return (
    extractMeta(html, 'og:title') ||
    decodeHtmlEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function extractDescription(html) {
  return extractMeta(html, 'description') || extractMeta(html, 'og:description') || extractMeta(html, 'twitter:description');
}

function stripHtmlToText(html) {
  return decodeHtmlEntities(
    String(html ?? '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
  ).trim();
}

function scoreImportedSource({ platform, status, title, description, text, fetchedBytes }) {
  let score = platform.baseScore;
  const signals = [];
  const warnings = [];

  if (status === 'fetched') {
    score += 8;
    signals.push('公开页面可访问');
  } else {
    score -= 14;
    warnings.push('页面未能公开抓取，需用户粘贴正文或截图描述');
  }
  if (title) {
    score += 4;
    signals.push('标题可解析');
  }
  if (description) {
    score += 6;
    signals.push('摘要可解析');
  }
  if (text.length > 900) {
    score += 5;
    signals.push('正文信息较完整');
  } else if (text.length < 160) {
    score -= 8;
    warnings.push('正文太短，可能只有分享页元数据');
  }
  if (/广告|赞助|团购|佣金|推广|合作/.test(`${title} ${description} ${text}`)) {
    score -= 8;
    warnings.push('疑似商业推广，需要降低采信权重');
  }
  if (/闭店|暂停|排队|涨价|预约|限流|维护/.test(`${title} ${description} ${text}`)) {
    signals.push('包含风险/限制信号');
  }
  if (fetchedBytes >= MAX_IMPORT_PAGE_BYTES * 0.95) {
    warnings.push('页面内容被截断，仅分析前半部分');
  }
  warnings.push(platform.note);

  return {
    score: clampNumber(score, 20, 94, 58),
    signals: signals.length ? signals : ['仅完成链接来源识别'],
    warnings
  };
}

async function fetchPublicPage(url, signal) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), IMPORT_TIMEOUT_MS);
  const abortFromCaller = () => controller.abort();
  signal?.addEventListener('abort', abortFromCaller, { once: true });
  try {
    const response = await fetchPublicPageResponse(url, controller.signal);
    const contentType = String(getResponseHeader(response.headers, 'content-type') ?? '').toLowerCase();
    if (!response.ok) {
      throw createHttpError(`公开页面返回 HTTP ${response.status}`, 502, 'SOURCE_FETCH_FAILED');
    }
    await assertPublicHttpResponseUrl(response.url);
    if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
      throw createHttpError('链接不是可分析的文本页面', 415, 'SOURCE_NOT_TEXT');
    }

    return { html: response.html, fetchedBytes: response.fetchedBytes, finalUrl: response.url };
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', abortFromCaller);
  }
}

export async function analyzeSourceUrl(rawUrl, signal) {
  const platform = detectPlatform(rawUrl);
  const url = await assertPublicHttpUrl(rawUrl);
  let fetched = null;
  let fetchError = '';
  try {
    fetched = await fetchPublicPage(url, signal);
  } catch (error) {
    fetchError = error.message ?? '页面无法公开抓取';
  }

  const html = fetched?.html ?? '';
  const title = extractTitle(html).slice(0, 120);
  const description = extractDescription(html).slice(0, 260);
  const text = stripHtmlToText(html).slice(0, 2800);
  const analysis = scoreImportedSource({
    platform,
    status: fetched ? 'fetched' : 'metadata-only',
    title,
    description,
    text,
    fetchedBytes: fetched?.fetchedBytes ?? 0
  });

  return {
    url: rawUrl,
    finalUrl: fetched?.finalUrl ?? url.toString(),
    platform: platform.name,
    platformId: platform.id,
    status: fetched ? 'fetched' : 'metadata-only',
    title: title || `${platform.name} 分享链接`,
    description,
    excerpt: text.slice(0, 700),
    trustScore: analysis.score,
    signals: analysis.signals,
    warnings: fetchError ? [fetchError, ...analysis.warnings] : analysis.warnings,
    fetchedAt: new Date().toISOString()
  };
}

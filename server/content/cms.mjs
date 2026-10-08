// CMS and product card configuration.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { CMS_CONFIG_PATH, PRODUCT_CONFIG_PATH } from '../config/index.mjs';
import { normalizeCityName, truncateString, clampNumber, stablePublicId, createHttpError, sanitizePublicId } from '../lib/util.mjs';
import { normalizeExternalUrl, safeExternalUrl } from '../lib/urls.mjs';
import { productCards as seedProductCards } from '../../src/lib/content.js';
import { getResolvableRoutebook } from '../routebooks/normalize.mjs';

export async function readCmsConfig() {
  if (!existsSync(CMS_CONFIG_PATH)) {
    return {
      defaultCity: '杭州',
      heroTitle: '把分散攻略，变成能照着走的可信路书',
      featuredCities: ['杭州', '上海', '苏州', '成都', '北京', '广州'],
      announcements: [],
      updatedAt: null
    };
  }
  try {
    return JSON.parse(await readFile(CMS_CONFIG_PATH, 'utf8'));
  } catch {
    return {
      defaultCity: '杭州',
      heroTitle: '把分散攻略，变成能照着走的可信路书',
      featuredCities: ['杭州', '上海', '苏州'],
      announcements: ['CMS 配置文件损坏，已回退默认配置'],
      updatedAt: null
    };
  }
}

export function normalizeCmsConfig(input) {
  return {
    defaultCity: normalizeCityName(input?.defaultCity ?? '杭州'),
    heroTitle: truncateString(input?.heroTitle, 80) || '把分散攻略，变成能照着走的可信路书',
    featuredCities: Array.isArray(input?.featuredCities)
      ? input.featuredCities.map((city) => normalizeCityName(city)).slice(0, 18)
      : ['杭州', '上海', '苏州'],
    announcements: Array.isArray(input?.announcements)
      ? input.announcements.map((item) => truncateString(item, 120)).filter(Boolean).slice(0, 8)
      : [],
    updatedAt: new Date().toISOString()
  };
}

export function normalizeProductCard(input = {}, index = 0, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const preserveTimestamps = options.preserveTimestamps === true;
  const strictUrl = options.strictUrl === true;
  const title = truncateString(input?.title, 100);
  if (!title) return null;
  const poi = truncateString(input?.poi, 80) || '目的地';
  const provider = truncateString(input?.provider, 60) || '运营配置';
  // 跨区契约：白名单透传外链落地信息，前端据此显示「外部搜索入口」等标签。
  // linkType 仅收枚举值，非法值直接丢弃而不是落库脏数据。
  const targetPoi = truncateString(input?.targetPoi, 80);
  const linkType = ['deep-link', 'seed-search', 'search'].includes(input?.linkType) ? input.linkType : '';
  const deepLinkStatus = truncateString(input?.deepLinkStatus, 40);
  return {
    id: stablePublicId(input?.id || `${provider}-${title}-${poi}`, 'product'),
    type: truncateString(input?.type, 30) || '本地玩乐',
    title,
    poi,
    city: input?.city ? normalizeCityName(input.city) : '',
    price: truncateString(input?.price, 40) || '查看详情',
    provider,
    url: strictUrl ? normalizeExternalUrl(input?.url) : safeExternalUrl(input?.url),
    status: ['active', 'paused'].includes(input?.status) ? input.status : 'active',
    sourceAuthorization: truncateString(input?.sourceAuthorization, 40) || 'affiliate-link',
    priority: clampNumber(input?.priority, 0, 1000, 100 - index),
    ...(targetPoi ? { targetPoi } : {}),
    ...(linkType ? { linkType } : {}),
    ...(deepLinkStatus ? { deepLinkStatus } : {}),
    ...(typeof input?.analyticsReady === 'boolean' ? { analyticsReady: input.analyticsReady } : {}),
    updatedAt: preserveTimestamps ? (truncateString(input?.updatedAt, 60) || now) : now
  };
}

export function normalizeProductConfig(input = {}, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const preserveTimestamps = options.preserveTimestamps === true;
  const strictUrl = options.strictUrl === true;
  const products = Array.isArray(input?.products)
    ? input.products.map((item, index) => normalizeProductCard(item, index, { now, preserveTimestamps, strictUrl })).filter(Boolean).slice(0, 120)
    : [];
  return {
    products,
    updatedAt: preserveTimestamps ? (truncateString(input?.updatedAt, 60) || null) : now
  };
}

export function seedProductConfig() {
  return normalizeProductConfig({ products: seedProductCards }, { preserveTimestamps: true });
}

export async function readProductConfig() {
  if (!existsSync(PRODUCT_CONFIG_PATH)) {
    return seedProductConfig();
  }
  try {
    const config = normalizeProductConfig(JSON.parse(await readFile(PRODUCT_CONFIG_PATH, 'utf8')), { preserveTimestamps: true });
    return config.products.length ? config : seedProductConfig();
  } catch {
    return seedProductConfig();
  }
}

// rank-seed：种子/兜底商品卡（linkType:'seed-search'，或带 seed 标记但不在运营
// 配置里）不再 400 UNKNOWN_PRODUCT，而是以 provider:'seed' 规范化落库并单独归组
// （analyticsSource:'seed-fallback'），保证兜底外链点击也能进归因漏斗。
export function hasSeedProductMarker(input = {}) {
  if (truncateString(input?.linkType, 40) === 'seed-search') return true;
  if (truncateString(input?.analyticsStatus, 40) === 'not_collected') return true;
  return /^seed-/.test(String(input?.productId ?? input?.id ?? ''));
}

export async function resolveProductAttribution(input = {}) {
  const config = await readProductConfig();
  const requestedId = stablePublicId(input?.productId || input?.id || input?.title, 'product');
  const requestedTitle = truncateString(input?.title || input?.productTitle || input?.product, 100);
  const configProduct = config.products.find((item) =>
    item.status !== 'paused' &&
    (item.id === requestedId || (requestedTitle && item.title === requestedTitle))
  );
  if (!configProduct && !hasSeedProductMarker(input)) {
    throw createHttpError('商品归因不存在或已暂停', 400, 'UNKNOWN_PRODUCT');
  }
  const seedFallback = !configProduct;
  const product = configProduct ?? {
    id: requestedId,
    type: truncateString(input?.type, 30) || '种子推荐',
    title: requestedTitle || '种子商品卡',
    poi: truncateString(input?.poi || input?.targetPoi || input?.stopName, 80) || '目的地',
    city: input?.city ? normalizeCityName(input.city) : '',
    price: truncateString(input?.price, 40) || '查看详情',
    provider: 'seed',
    url: safeExternalUrl(input?.url),
    status: 'active'
  };
  const routeId = sanitizePublicId(input?.routeId || input?.publicId);
  const routebook = routeId ? await getResolvableRoutebook(routeId) : null;
  return {
    product,
    routebook,
    seedFallback,
    derived: {
      itemType: 'product',
      itemId: product.id,
      productId: product.id,
      productTitle: product.title,
      routeId: routebook?.publicId || routebook?.id || routeId,
      routeTitle: routebook?.title || truncateString(input?.routeTitle, 100),
      city: routebook?.city || product.city || (input?.city ? normalizeCityName(input.city) : ''),
      creatorId: routebook?.creator?.id || sanitizePublicId(input?.creatorId)
    }
  };
}

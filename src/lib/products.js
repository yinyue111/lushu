import { useEffect, useMemo, useState } from 'react';
import { productCards } from './content.js';
import { getProducts } from './api.js';

export function useProductCards() {
  const [remoteState, setRemoteState] = useState({ status: 'loading', products: [] });

  useEffect(() => {
    const ctrl = new AbortController();
    getProducts(ctrl.signal)
      .then((data) => {
        if (ctrl.signal.aborted) return;
        setRemoteState({
          status: 'ready',
          products: (data.products ?? [])
            .filter((item) => item.status !== 'paused')
            .map((item) => ({ ...item, analyticsReady: true }))
        });
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setRemoteState({ status: 'error', products: [] });
      });
    return () => ctrl.abort();
  }, []);

  return useMemo(() => {
    // 只有在请求失败时才回退种子卡；请求成功但列表为空/全部 paused 表示运营下架，返回空列表。
    if (remoteState.status !== 'error') return remoteState.products;
    return productCards.map((item, index) => ({
      ...item,
      id: item.id || `seed-product-${index + 1}`,
      status: 'active',
      priority: 100 - index,
      analyticsReady: false
    }));
  }, [remoteState]);
}

// 服务端 normalizeProductCard 现已白名单透传 linkType（deep-link|seed-search|search，
// 非法值被丢弃）与 deepLinkStatus（截 40 的自由文本）。种子搜索卡、纯搜索链接或
// 深链未就绪（deepLinkStatus 非 ready/verified）时，一律按「外部搜索入口」处理。
export function isExternalSearchEntry(product) {
  const linkType = String(product?.linkType ?? '').trim();
  if (linkType === 'seed-search' || linkType === 'search') return true;
  const deepLinkStatus = String(product?.deepLinkStatus ?? '').trim();
  return Boolean(deepLinkStatus) && !['ready', 'verified'].includes(deepLinkStatus);
}

export function productMatchesStop(product, stopName) {
  const name = String(stopName ?? '').trim();
  if (!product || !name) return false;
  const keywords = Array.isArray(product.keywords)
    ? product.keywords
    : String(product.keywords ?? '').split(/[、,，;；\s]+/);
  return [product.poi, product.targetPoi, ...keywords]
    .map((value) => String(value ?? '').trim())
    .filter((value) => value.length >= 2)
    .some((value) => value === name || name.includes(value) || value.includes(name));
}

export function productsForStop(products, stopName) {
  return (Array.isArray(products) ? products : [])
    .filter((item) => item && item.status !== 'paused' && productMatchesStop(item, stopName))
    .sort(byPriorityDesc);
}

export function productsForRoutebook(products, routebook, limit = 4) {
  const max = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : 4;
  const city = String(routebook?.city ?? '').trim();
  const stops = (Array.isArray(routebook?.stops) ? routebook.stops : []).filter(Boolean);
  const active = (Array.isArray(products) ? products : []).filter((item) => item && item.status !== 'paused');
  const cityScoped = active.filter((item) => !item.city || !city || item.city === city);
  const matched = cityScoped
    .filter((item) => stops.some((stop) => productMatchesStop(item, stop?.name) || productMatchesStop(item, stop?.area)))
    .sort(byPriorityDesc)
    .map((item) => ({ ...item, matchLevel: 'route-poi' }));
  if (matched.length >= max) return matched.slice(0, max);
  const matchedKeys = new Set(matched.map(productKey));
  const generic = cityScoped
    .filter((item) => !matchedKeys.has(productKey(item)))
    .filter((item) => (city && item.city === city) || /酒店|本地玩乐|讲解|通用/.test(String(item.type ?? '')))
    .sort(byPriorityDesc)
    .map((item) => ({ ...item, matchLevel: 'generic' }));
  return [...matched, ...generic].slice(0, max);
}

function byPriorityDesc(a, b) {
  return Number(b.priority ?? 0) - Number(a.priority ?? 0);
}

function productKey(item) {
  return item?.id || `${item?.provider ?? ''}-${item?.title ?? ''}-${item?.poi ?? ''}`;
}

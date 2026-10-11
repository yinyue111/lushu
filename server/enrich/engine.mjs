// Enrichment of one routebook: ticket price / 免费 and opening hours for scenic stops only.
// Rules (never fabricate):
//  - restaurants are never enriched; chains without a named branch are never enriched;
//  - a value is filled only when two independent sources agree: AMap + one verified web page, or two
//    verified web pages on different sites. "Verified" = we fetched the page ourselves and the value
//    literally appears near the place name. 全天开放 == 00:00-24:00;
//  - conflicts, a single source, or nothing found → the stop keeps 待确认 (recorded with the reason);
//  - per-routebook budget (searches, USD) and a global daily USD budget; results cached per city+place+field.
import {
  ENRICH_ASSUMED_USD_PER_SEARCH,
  ENRICH_CACHE_DAYS,
  ENRICH_DAILY_BUDGET_USD,
  ENRICH_MAX_SEARCHES_PER_ROUTEBOOK,
  ENRICH_MAX_USD_PER_ROUTEBOOK
} from '../config/index.mjs';
import { amapPlace, webSearchPlace } from './sources.mjs';
import { fetchCitedPage, isBlockedDomain, siteOf } from './pages.mjs';
import { canonicalHours, canonicalPrice, compact, hoursEvidence, priceDisplay, priceEvidence, priceKey } from './text.mjs';

export const ENRICH_FIELDS = /** @type {const} */ (['price', 'hours']);
const FIELD_LABEL = { price: '门票', hours: '开放时间' };
const ATTRACTION_NAME = /(寺|庙|道观|祠|宫|塔|阁|园|湖|山|峰|桥|堤|岛|街|巷|锦里|坊|古镇|景区|公园|博物馆|纪念馆|美术馆|广场|故居|遗址|陵|城墙|码头)$/;
const RESTAURANT_NAME = /店$|饭|面|饺|馆$|餐|火锅|小吃|茶社|茶馆|咖啡|酒吧|甜品|烧烤|串串/;
const MAX_PAGES_PER_FIELD = 6;
const MAX_PAGES_PER_ROUTEBOOK = 80;

export const cacheKeyFor = (city, name, field) => `${String(city).trim()}|${String(name).trim()}|${field}`;
export const stopKeyOf = (stop, index) => String(stop.id ?? stop.stopId ?? `#${index}`);

/** Which fields of a stop still need a source. Price only when the routebook has no known price. */
export function wantedFields(stop) {
  const cost = `${stop.cost ?? ''} ${stop.costInfo?.text ?? ''}`;
  const priceKnown = stop.costInfo?.known === true || stop.costInfo?.free === true || (/\d|免费/.test(cost) && !/待确认|未知|为准/.test(cost));
  return [...(priceKnown ? [] : ['price']), 'hours'];
}

/** Value appears on the page within a window around the place name. */
export function pageSupports(pageText, placeName, patterns) {
  const text = compact(pageText);
  const name = compact(placeName);
  if (!name || !text.includes(name)) return false;
  for (let i = text.indexOf(name); i >= 0; i = text.indexOf(name, i + name.length)) {
    const window = text.slice(Math.max(0, i - 300), i + name.length + 300);
    if (patterns.every((re) => re.test(window))) return true;
  }
  return false;
}

function display(field, value, sources, retrievedAt) {
  const first = sources[0];
  const firstName = first.kind === 'amap' ? '高德' : first.title || first.domain;
  const label = field === 'price' ? value : `开放时间 ${value === '00:00-24:00' ? '全天开放' : value}`;
  return `${label} · 来自${firstName}${sources.length > 1 ? `等${sources.length}个来源` : ''} · 查询于${retrievedAt.slice(0, 10)}`;
}

/**
 * @param {{ routebook: any, deps?: any, store: any, now?: () => number, log?: (event: any) => void }} input
 */
export async function enrichRoutebook({ routebook, store, deps = {}, now = () => Date.now(), log = () => {} }) {
  const amap = deps.amapPlace ?? amapPlace;
  const search = deps.webSearchPlace ?? webSearchPlace;
  const fetchUncached = deps.fetchCitedPage ?? fetchCitedPage;
  // One fetch per URL per routebook: the page that showed the price is reused for the hours.
  const pageCache = new Map();
  const fetchPage = (url) => {
    if (!pageCache.has(url)) {
      counts.pages += 1;
      pageCache.set(url, fetchUncached(url));
    }
    return pageCache.get(url);
  };
  const city = routebook.city ?? '';
  const budget = { searches: 0, usd: 0, maxUsd: 0, stoppedBy: '', lastError: '' };
  const counts = { filled: 0, kept: 0, cached: 0, skippedStops: 0, searches: 0, pages: 0, amapCalls: 0, usd: 0 };
  /** @type {any[]} */
  const claims = [];
  const retrievedAt = () => new Date(now()).toISOString();

  for (const [index, stop] of (routebook.stops ?? []).entries()) {
    const stopKey = stopKeyOf(stop, index);
    const name = String(stop.name ?? '').trim();
    if (!name) continue;
    const base = { stopKey, stopName: name };
    const keep = (field, reason, extra = {}) => {
      counts.kept += 1;
      claims.push({ ...base, field, status: 'kept', reason, ...extra });
    };
    const fields = wantedFields(stop);

    // Cache first: popular places are looked up once per ENRICH_CACHE_DAYS.
    const pending = [];
    for (const field of fields) {
      const key = cacheKeyFor(city, name, field);
      const hit = await store.getCache(key, now());
      if (hit) {
        counts.cached += 1;
        if (hit.status === 'filled') counts.filled += 1;
        else counts.kept += 1;
        claims.push({ ...base, field, ...hit, cacheKey: key, fromCache: true });
      } else pending.push(field);
    }
    if (!pending.length) continue;

    counts.amapCalls += 1;
    const place = await amap({ name, city, lat: Number(stop.lat), lng: Number(stop.lng) });
    if (place.status === 'chain') {
      for (const field of pending) await remember(field, { status: 'kept', reason: 'chain', reasonText: '连锁店，攻略没写哪一家' });
      continue;
    }
    if (place.status === 'restaurant' || (place.status !== 'matched' && RESTAURANT_NAME.test(name) && !ATTRACTION_NAME.test(name))) {
      counts.skippedStops += 1;
      continue; // restaurants: address / phone / 人均 are out of scope
    }
    const attraction = place.status === 'matched' ? place.poi.attraction || ATTRACTION_NAME.test(name) : ATTRACTION_NAME.test(name);
    if (!attraction) {
      counts.skippedStops += 1;
      continue;
    }

    // Web search (one per stop, both fields), within the per-routebook and daily budgets.
    const trySearch = async (fields, variant) => {
      const spend = await store.getSpend(now());
      // Expected cost of the next search: the dearest search so far in this routebook, at least the assumed price.
      const projected = Math.max(ENRICH_ASSUMED_USD_PER_SEARCH, budget.maxUsd);
      if (budget.searches >= ENRICH_MAX_SEARCHES_PER_ROUTEBOOK) budget.stoppedBy = 'searches';
      else if (budget.usd + projected > ENRICH_MAX_USD_PER_ROUTEBOOK + 1e-9) budget.stoppedBy = 'routebook-usd';
      else if (spend.usd + projected > ENRICH_DAILY_BUDGET_USD + 1e-9) budget.stoppedBy = 'daily-usd';
      else {
        let result;
        try {
          result = await search({ name, city, fields, variant });
        } catch (error) {
          // A slow or failing search only costs this stop (kept 待确认, not cached); the rest go on.
          counts.searchErrors = (counts.searchErrors ?? 0) + 1;
          budget.lastError = String(error?.name === 'TimeoutError' ? 'search timeout' : (error?.message ?? error));
          return 'error';
        }
        const usd = result.usd ?? ENRICH_ASSUMED_USD_PER_SEARCH;
        budget.searches += 1;
        budget.usd += usd;
        budget.maxUsd = Math.max(budget.maxUsd, usd);
        counts.searches += 1;
        counts.usd += usd;
        await store.addSpend({ usd, searches: 1 }, now());
        return result;
      }
      return null;
    };
    const first = await trySearch(pending, 0);
    if (first === 'error') {
      for (const field of pending) keep(field, 'search-failed', { reasonText: '联网搜索暂时失败，稍后会再试' });
      continue;
    }
    if (!first) {
      // Out of budget: keep 待确认 without caching, so a later routebook can try again.
      for (const field of pending) keep(field, 'budget', { reasonText: '本次核对额度已用完' });
      continue;
    }
    if (first.answer?.ambiguous && place.status !== 'matched') {
      for (const field of pending) await remember(field, { status: 'kept', reason: 'ambiguous', reasonText: '同名地点不止一处' });
      continue;
    }

    /** Decide one field from one or more searches. Same rules every time; nothing is remembered here. */
    const decide = async (field, webs) => {
      const amapHours = field === 'hours' && place.status === 'matched' ? canonicalHours(place.poi.hours) : '';
      const parse = (raw) => (field === 'hours' ? canonicalHours(raw ?? '') : canonicalPrice(raw ?? ''));
      const key = (c) => (field === 'hours' ? c : priceKey(c));
      const values = webs.map((w) => parse(w.answer?.[field])).filter(Boolean);
      if (!values.length) {
        return {
          status: 'kept',
          reason: amapHours ? 'single-source' : 'not-found',
          reasonText: amapHours ? `只有高德一个来源（${amapHours}）` : '没有找到可靠来源'
        };
      }
      if (new Set(values.map(key)).size > 1) {
        return { status: 'kept', reason: 'conflict', reasonText: `搜索结果说法不一（${[...new Set(values.map(key))].join(' / ')}）` };
      }
      const canonical = values[0];
      const patterns = field === 'hours' ? hoursEvidence(/** @type {string} */ (canonical)) : priceEvidence(canonical);
      const verified = [];
      for (const w of webs) {
        // Only URLs the search really returned; the ones the model named for this field first.
        const named = (w.answer?.[`${field}Sources`] ?? []).filter((u) => w.cited.has(u));
        const urls = [...new Set([...named, ...w.cited.keys()])].filter((u) => {
          try {
            return !isBlockedDomain(new URL(u).hostname);
          } catch {
            return false;
          }
        });
        for (const [i, url] of urls.entries()) {
          if (verified.length >= 2 || counts.pages >= MAX_PAGES_PER_ROUTEBOOK) break;
          if (i >= MAX_PAGES_PER_FIELD + named.length) break;
          const domain = siteOf(new URL(url).hostname);
          if (verified.some((v) => v.domain === domain)) continue;
          const page = await fetchPage(url);
          if (page.ok && pageSupports(page.text, name, patterns)) verified.push({ kind: 'web', url, title: page.title || w.cited.get(url) || '', domain });
        }
      }
      const value = field === 'hours' ? /** @type {string} */ (canonical) : priceDisplay(canonical);
      const at = retrievedAt();
      if (field === 'hours' && amapHours && amapHours !== canonical) {
        return { status: 'kept', reason: 'conflict', reasonText: `各来源说法不一（高德 ${amapHours}，网页 ${canonical}）` };
      }
      if (field === 'hours' && amapHours === canonical && verified.length >= 1) {
        const sources = [{ kind: 'amap', url: place.poi.url, title: `高德地图 · ${place.poi.name}`, domain: 'amap.com' }, ...verified.slice(0, 2)];
        return { status: 'filled', value, display: display(field, value, sources, at), sources, retrievedAt: at, method: 'amap+page' };
      }
      if (verified.length >= 2) {
        return {
          status: 'filled',
          value,
          ...(field === 'price' ? { price: priceKey(canonical) } : {}),
          display: display(field, value, verified, at),
          sources: verified,
          retrievedAt: at,
          method: 'pages'
        };
      }
      return { status: 'kept', reason: 'single-source', reasonText: `只核对到 ${verified.length + (amapHours ? 1 : 0)} 个来源` };
    };

    const decisions = new Map();
    for (const field of pending) decisions.set(field, await decide(field, [first]));
    // One more try, with a differently worded query, for fields that stopped at a single source.
    const retry = pending.filter((field) => decisions.get(field).reason === 'single-source');
    if (retry.length) {
      const second = await trySearch(retry, 1);
      if (second && second !== 'error') {
        counts.retried = (counts.retried ?? 0) + retry.length;
        for (const field of retry) decisions.set(field, await decide(field, [first, second]));
      }
    }
    for (const field of pending) await remember(field, decisions.get(field));

    async function remember(field, entry) {
      const key = cacheKeyFor(city, name, field);
      if (entry.status === 'filled') counts.filled += 1;
      else counts.kept += 1;
      claims.push({ ...base, field, ...entry, cacheKey: key });
      if (ENRICH_CACHE_DAYS > 0) await store.putCache(key, entry, new Date(now() + ENRICH_CACHE_DAYS * 86400000).toISOString());
    }
  }
  await store.addSpend({ pages: counts.pages, amapCalls: counts.amapCalls }, now());
  const summary = { ...counts, usd: Number(counts.usd.toFixed(4)), stoppedBy: budget.stoppedBy };
  log({ event: 'enrich', routebookId: routebook.id, ...summary });
  return { claims, summary };
}

export { FIELD_LABEL };

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
const MAX_PAGES_PER_FIELD = 4;

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
  const fetchPage = deps.fetchCitedPage ?? fetchCitedPage;
  const city = routebook.city ?? '';
  const budget = { searches: 0, usd: 0, stoppedBy: '' };
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
    let web = null;
    const spend = await store.getSpend(now());
    // Expected cost of the next search: what searches cost so far in this routebook, or the assumed price.
    const projected = budget.searches ? Math.max(ENRICH_ASSUMED_USD_PER_SEARCH, budget.usd / budget.searches) : ENRICH_ASSUMED_USD_PER_SEARCH;
    if (budget.searches >= ENRICH_MAX_SEARCHES_PER_ROUTEBOOK) budget.stoppedBy = 'searches';
    else if (budget.usd + projected > ENRICH_MAX_USD_PER_ROUTEBOOK + 1e-9) budget.stoppedBy = 'routebook-usd';
    else if (spend.usd + projected > ENRICH_DAILY_BUDGET_USD + 1e-9) budget.stoppedBy = 'daily-usd';
    else {
      web = await search({ name, city, fields: pending });
      const usd = web.usd ?? ENRICH_ASSUMED_USD_PER_SEARCH;
      budget.searches += 1;
      budget.usd += usd;
      counts.searches += 1;
      counts.usd += usd;
      await store.addSpend({ usd, searches: 1 }, now());
    }
    if (!web) {
      // Out of budget: keep 待确认 without caching, so a later routebook can try again.
      for (const field of pending) keep(field, 'budget', { reasonText: '本次核对额度已用完' });
      continue;
    }
    if (web.answer?.ambiguous && place.status !== 'matched') {
      for (const field of pending) await remember(field, { status: 'kept', reason: 'ambiguous', reasonText: '同名地点不止一处' });
      continue;
    }

    for (const field of pending) {
      const webValueRaw = web.answer?.[field];
      const amapHours = field === 'hours' && place.status === 'matched' ? canonicalHours(place.poi.hours) : '';
      const canonical = field === 'hours' ? canonicalHours(webValueRaw ?? '') : canonicalPrice(webValueRaw ?? '');
      if (!canonical) {
        await remember(field, {
          status: 'kept',
          reason: amapHours ? 'single-source' : 'not-found',
          reasonText: amapHours ? `只有高德一个来源（${amapHours}）` : '没有找到可靠来源'
        });
        continue;
      }
      const patterns = field === 'hours' ? hoursEvidence(/** @type {string} */ (canonical)) : priceEvidence(canonical);
      // Only URLs the search really returned; the ones the model named for this field first.
      const named = (web.answer?.[`${field}Sources`] ?? []).filter((u) => web.cited.has(u));
      const urls = [...new Set([...named, ...web.cited.keys()])].filter((u) => {
        try {
          return !isBlockedDomain(new URL(u).hostname);
        } catch {
          return false;
        }
      });
      const verified = [];
      for (const url of urls) {
        if (verified.length >= 2 || counts.pages >= 12) break;
        if (urls.indexOf(url) >= MAX_PAGES_PER_FIELD + named.length) break;
        const domain = siteOf(new URL(url).hostname);
        if (verified.some((v) => v.domain === domain)) continue;
        counts.pages += 1;
        const page = await fetchPage(url);
        if (page.ok && pageSupports(page.text, name, patterns)) verified.push({ kind: 'web', url, title: page.title || web.cited.get(url) || '', domain });
      }
      const value = field === 'hours' ? /** @type {string} */ (canonical) : priceDisplay(canonical);
      const at = retrievedAt();
      if (field === 'hours' && amapHours && amapHours !== canonical) {
        await remember(field, { status: 'kept', reason: 'conflict', reasonText: `各来源说法不一（高德 ${amapHours}，网页 ${canonical}）` });
      } else if (field === 'hours' && amapHours === canonical && verified.length >= 1) {
        const sources = [{ kind: 'amap', url: place.poi.url, title: `高德地图 · ${place.poi.name}`, domain: 'amap.com' }, ...verified.slice(0, 2)];
        await remember(field, { status: 'filled', value, display: display(field, value, sources, at), sources, retrievedAt: at, method: 'amap+page' });
      } else if (verified.length >= 2) {
        await remember(field, {
          status: 'filled',
          value,
          ...(field === 'price' ? { price: priceKey(canonical) } : {}),
          display: display(field, value, verified, at),
          sources: verified,
          retrievedAt: at,
          method: 'pages'
        });
      } else {
        await remember(field, { status: 'kept', reason: 'single-source', reasonText: `只核对到 ${verified.length + (amapHours ? 1 : 0)} 个来源` });
      }
    }

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

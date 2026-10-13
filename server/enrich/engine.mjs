// Enrichment of one routebook: ticket price / 免费 and opening hours for scenic stops only.
// Rules (never fabricate):
//  - restaurants are never enriched; chains without a named branch are never enriched;
//  - a value is filled only when two independent sources agree: AMap + one verified web page, or two
//    verified web pages on different sites. "Verified" = we fetched the page ourselves and the value
//    literally appears near the place name. 全天开放 == 00:00-24:00;
//  - conflicts, a single source, or nothing found → the stop keeps 待确认 (recorded with the reason);
//  - per-routebook budget (searches, USD) and a global daily USD budget; results cached per city+place+field.
import { getConfig } from '../config/runtime.mjs';
import { verifiedFactClaim } from '../admin/verifiedFacts.mjs';
import { raiseAlert } from '../ops/alerts.mjs';
import { ENRICH_ASSUMED_USD_PER_SEARCH, ENRICH_CACHE_DAYS, ENRICH_MAX_USD_PER_ROUTEBOOK } from '../config/index.mjs';
import { amapPlace, webSearchPlace } from './sources.mjs';
import { fetchCitedPage, isBlockedDomain, siteOf } from './pages.mjs';
import { canonicalHours, canonicalPrice, compact, hoursEvidence, priceDisplay, priceEvidence, priceKey } from './text.mjs';

export const ENRICH_FIELDS = /** @type {const} */ (['price', 'hours']);
const FIELD_LABEL = { price: '门票', hours: '开放时间' };
const ATTRACTION_NAME = /(寺|庙|道观|祠|宫|塔|阁|园|湖|山|峰|桥|堤|岛|街|巷|锦里|坊|古镇|景区|公园|博物馆|纪念馆|美术馆|广场|故居|遗址|陵|城墙|码头)$/;
const RESTAURANT_NAME = /店$|饭|面|饺|馆$|餐|火锅|小吃|茶社|茶馆|咖啡|酒吧|甜品|烧烤|串串/;
const MAX_PAGES_PER_FIELD = 6;
const MAX_PAGES_PER_ROUTEBOOK = 80;

const TICKETED = /(寺|庙|道观|祠|宫|塔|阁|园|博物馆|纪念馆|美术馆|故居|遗址|陵|景区|古镇|城墙|乐园)$/;
const FREE_STREET = /(街|巷|路|坊|广场|桥|堤|码头|夜市|步行街)$/;

/** 补全顺序：0 收票/要预约的景点，1 其他，2 免费街区。 */
export function enrichPriority(stop) {
  const name = String(stop?.name ?? '').trim();
  const notes = `${stop?.verify ?? ''}${stop?.risk ?? ''}${stop?.cost ?? ''}`;
  if (TICKETED.test(name) || /预约|门票|购票/.test(notes)) return 0;
  if (FREE_STREET.test(name)) return 2;
  return 1;
}

export const cacheKeyFor = (city, name, field) => `${String(city).trim()}|${String(name).trim()}|${field}`;
export const stopKeyOf = (stop, index) => String(stop.id ?? stop.stopId ?? `#${index}`);

/** Which fields of a stop still need a source. Price only when the routebook has no known price. */
export function wantedFields(stop) {
  const cost = `${stop.cost ?? ''} ${stop.costInfo?.text ?? ''}`;
  // 只有用户自己填的、或攻略里写明的价格才算已知；模型凭记忆写的「免费 / X 元」也要核对（灵隐寺就是旧价格的例子）。
  const trusted = stop.costInfo?.source === 'user' || stop.costInfo?.basis === 'guide';
  const priceKnown = trusted && (stop.costInfo?.known === true || stop.costInfo?.free === true || (/\d|免费/.test(cost) && !/待确认|未知|为准/.test(cost)));
  return [...(priceKnown ? [] : ['price']), 'hours'];
}

/** Value appears on the page within a window around the place name. */
/** Short quote from the page around the first evidence match near the place name (for the correction queue). */
export function evidenceQuote(pageText, placeName, patterns) {
  const text = compact(pageText);
  const name = compact(placeName);
  for (let i = text.indexOf(name); name && i >= 0; i = text.indexOf(name, i + name.length)) {
    const window = text.slice(Math.max(0, i - 300), i + name.length + 300);
    if (!patterns.every((re) => re.test(window))) continue;
    const m = patterns[0].exec(window);
    if (!m) continue;
    return window.slice(Math.max(0, m.index - 50), m.index + m[0].length + 50).slice(0, 120);
  }
  return '';
}

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

const CONDITION_RULES = [
  { kind: 'reservation', label: '需提前预约', re: /(实名预约|提前预约|需预约|须预约|需要预约|预约入园|预约参观|预约游览|预约后)/ },
  {
    kind: 'extra-charge',
    label: '部分区域另收费',
    re: /(另收费|另行收费|单独收费|另需购票|需另购|另购门票|单独购票|另行购票|内[^，,。]{0,6}(场馆|景点)[^，,。]{0,2}收费)/
  },
  { kind: 'special-date', label: '特殊日期票价不同', re: /(特殊日期|节假日|法定假日|节日期间)[^。；]{0,8}\d+\s*元/ },
  { kind: 'seasonal-hours', label: '冬夏开放时间不同', re: /(夏令时|冬令时|夏季开放|冬季开放)/ },
  { kind: 'seasonal', label: '票价分淡旺季', re: /(淡季|旺季)[^。；]{0,30}\d+\s*元/ }
];

/**
 * 附带条件：只从抓到的页面原文里摘，地点名附近的那一句原话；不推断、不改写。
 * @returns {{ kind: string, label: string, quote: string }[]}
 */
export function extractConditions(pageText, placeName, { pageTitle = '' } = {}) {
  const name = compact(placeName);
  const found = new Map();
  if (!name) return [];
  // 先按原文的句号、换行、成段空白（块级标签转成的空格、全角空格）切句，再逐句去空白。
  const sentences = String(pageText ?? '')
    .replace(/<\/?(p|br|li|div|h\d|tr|td)\b[^>]*>/gi, '\n')
    .split(/[。；！？!?\n|]|[\s\u3000]{2,}/)
    .map((x) => compact(x));
  const comparesOther = new RegExp(`[与和跟同][^，,]{0,2}${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  // 一般页面：同一句里要有地点名（近邻句常是别的景点）。
  // 讲这个地方本身的页面（标题里有地点名，如官网、专题页）：地点名所在句之后 3 句以内也算。
  const aboutThisPlace = compact(pageTitle).includes(name);
  const allowed = new Set();
  sentences.forEach((sentence, index) => {
    if (!sentence.includes(name) || comparesOther.test(sentence)) return;
    allowed.add(index);
    if (aboutThisPlace) for (let k = 1; k <= 3 && index + k < sentences.length; k += 1) allowed.add(index + k);
  });
  for (const index of [...allowed].sort((x, y) => x - y)) {
    const quote = sentences[index];
    if (!quote || quote.length > 120 || comparesOther.test(quote)) continue;
    for (const rule of CONDITION_RULES) {
      if (found.has(rule.kind) || !rule.re.test(quote)) continue;
      // 否定说法不算（实测：「鸡鸣寺赏樱不需要预约」）。
      if (rule.kind === 'reservation' && /(不需|无需|不用|免)(要)?(提前)?(实名)?预约/.test(quote)) continue;
      found.set(rule.kind, { kind: rule.kind, label: rule.label, quote });
    }
  }
  return [...found.values()];
}

/** 官方来源优先抓：政府域名，或标题里有地点名且写着官网 / 官方。 */
export function isOfficialSource(url, title, placeName) {
  try {
    const host = new URL(url).hostname;
    if (/\.gov\.cn$/.test(host)) return true;
    return Boolean(placeName) && String(title).includes(placeName) && /官网|官方/.test(String(title));
  } catch {
    return false;
  }
}

/** 合并各页条件：同一类在几个不同网站原文里出现。 */
function mergeConditions(perPage) {
  const byKind = new Map();
  for (const { conditions, url, domain } of perPage) {
    for (const c of conditions) {
      const entry = byKind.get(c.kind) ?? { kind: c.kind, label: c.label, quote: c.quote, sources: [] };
      if (!entry.sources.some((s) => s.domain === domain)) entry.sources.push({ url, domain });
      byKind.set(c.kind, entry);
    }
  }
  return [...byKind.values()].map((c) => ({ ...c, verifiedCount: c.sources.length, singleSource: c.sources.length < 2 }));
}

/** 票价分淡旺季（或特殊日期另价）：单个数字会误导，保留待确认。 */
export function pageHasSeasonalPrice(pageText, placeName) {
  const text = compact(pageText);
  const name = compact(placeName);
  for (let i = text.indexOf(name); name && i >= 0; i = text.indexOf(name, i + name.length)) {
    const window = text.slice(Math.max(0, i - 300), i + name.length + 300);
    if (/(淡季|旺季)[^。；]{0,30}\d+\s*元/.test(window)) return true;
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
 * @param {{ routebook: any, deps?: any, store: any, now?: () => number, log?: (event: any) => void, onProgress?: ((progress: any) => void) | null }} input
 */
export async function enrichRoutebook({ routebook, store, deps = {}, now = () => Date.now(), log = () => {}, onProgress = null }) {
  const amap = deps.amapPlace ?? amapPlace;
  const search = deps.webSearchPlace ?? webSearchPlace;
  const fetchUncached = deps.fetchCitedPage ?? fetchCitedPage;
  const lookupVerified = deps.verifiedFact ?? verifiedFactClaim;
  // Runtime config (admin console), read once per run.
  const ENRICH_MAX_SEARCHES_PER_ROUTEBOOK = getConfig('enrich.maxSearchesPerRun');
  const ENRICH_DAILY_BUDGET_USD = getConfig('enrich.dailyBudgetUsd');
  const ENRICH_BUDGET_ALERT_RATIO = getConfig('enrich.budgetAlertRatio');
  const maxStops = getConfig('enrich.maxStopsPerRun');
  const minSources = getConfig('enrich.requireTwoSources') ? 2 : 1;
  let stopsLooked = 0;
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
  const counts = { searchErrors: 0, filled: 0, kept: 0, cached: 0, skippedStops: 0, searches: 0, pages: 0, amapCalls: 0, usd: 0 };
  /** @type {any[]} */
  const claims = [];
  const retrievedAt = () => new Date(now()).toISOString();
  const stopsTotal = (routebook.stops ?? []).length;
  const report = async (stopsDone, lastStop = '') => {
    if (!onProgress) return;
    await onProgress({
      filled: counts.filled,
      kept: counts.kept,
      cached: counts.cached,
      searches: counts.searches,
      stopsDone,
      stopsTotal,
      lastStop: String(lastStop).slice(0, 40),
      nextStop: String(ordered[stopsDone]?.[1]?.name ?? '')
        .trim()
        .slice(0, 40),
      phase: 'checking'
    });
  };

  let done = 0;
  const step = (name) => report(++done, name);
  // 先查收门票、要预约的景点，免费街区放最后：单本花费上限截断时，丢的是最不影响进门的那几站。
  const ordered = [...(routebook.stops ?? []).entries()].sort(([ia, a], [ib, b]) => enrichPriority(a) - enrichPriority(b) || ia - ib);
  for (const [index, stop] of ordered) {
    const stopKey = stopKeyOf(stop, index);
    const name = String(stop.name ?? '').trim();
    if (!name) {
      await step(name);
      continue;
    }
    const base = { stopKey, stopName: name };
    const keep = (field, reason, extra = {}) => {
      counts.kept += 1;
      claims.push({ ...base, field, status: 'kept', reason, ...extra });
    };
    let fields = wantedFields(stop);

    // Operator-verified values (admin console) win over the auto cache until they expire.
    const unverified = [];
    for (const field of fields) {
      const key = cacheKeyFor(city, name, field);
      const fact = await lookupVerified(key, now());
      if (fact) {
        counts.filled += 1;
        claims.push({ ...base, field, ...fact, cacheKey: key });
      } else unverified.push(field);
    }
    fields = unverified;

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
    if (!pending.length) {
      await step(name);
      continue;
    }
    if (maxStops > 0 && stopsLooked >= maxStops) {
      budget.stoppedBy ||= 'stops';
      for (const field of pending) keep(field, 'stops-limit');
      await step(name);
      continue;
    }
    stopsLooked += 1;

    counts.amapCalls += 1;
    const place = await amap({ name, city, lat: Number(stop.lat), lng: Number(stop.lng) });
    if (place.status === 'chain') {
      for (const field of pending) await remember(field, { status: 'kept', reason: 'chain', reasonText: '连锁店，攻略没写哪一家' });
      await step(name);
      continue;
    }
    if (place.status === 'restaurant' || (place.status !== 'matched' && RESTAURANT_NAME.test(name) && !ATTRACTION_NAME.test(name))) {
      counts.skippedStops += 1;
      await step(name);
      continue; // restaurants: address / phone / 人均 are out of scope
    }
    const attraction = place.status === 'matched' ? place.poi.attraction || ATTRACTION_NAME.test(name) : ATTRACTION_NAME.test(name);
    if (!attraction) {
      counts.skippedStops += 1;
      await step(name);
      continue;
    }

    // Web search (one per stop, both fields), within the per-routebook and daily budgets.
    const trySearch = async (fields, variant) => {
      const spend = await store.getSpend(now());
      // Expected cost of the next search: the dearest search so far in this routebook, at least the assumed price.
      const projected = Math.max(ENRICH_ASSUMED_USD_PER_SEARCH, budget.maxUsd);
      if (budget.searches >= ENRICH_MAX_SEARCHES_PER_ROUTEBOOK) budget.stoppedBy = 'searches';
      else if (budget.usd + projected > ENRICH_MAX_USD_PER_ROUTEBOOK + 1e-9) budget.stoppedBy = 'routebook-usd';
      else if (spend.usd + projected > ENRICH_DAILY_BUDGET_USD + 1e-9) {
        budget.stoppedBy = 'daily-usd';
        void raiseAlert('enrich-daily-budget', `联网补全今日预算用完：$${spend.usd.toFixed(2)} / $${ENRICH_DAILY_BUDGET_USD}`);
      } else {
        let result;
        try {
          result = await search({ name, city, fields, variant });
        } catch (error) {
          // A slow or failing search only costs this stop (kept 待确认, not cached); the rest go on.
          counts.searchErrors += 1;
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
        // 补全花费计入当日预算（每份路书实测约 $0.5）；到 80% 先提醒一次。
        const spentToday = spend.usd + usd;
        if (ENRICH_DAILY_BUDGET_USD > 0 && spentToday >= ENRICH_DAILY_BUDGET_USD * ENRICH_BUDGET_ALERT_RATIO) {
          void raiseAlert('enrich-budget-high', `联网补全今日已花 $${spentToday.toFixed(2)}，预算 $${ENRICH_DAILY_BUDGET_USD}`);
        }
        return result;
      }
      return null;
    };
    const first = await trySearch(pending, 0);
    if (first === 'error') {
      for (const field of pending) keep(field, 'search-failed', { reasonText: '联网搜索暂时失败，稍后会再试' });
      await step(name);
      continue;
    }
    if (!first) {
      // Out of budget: keep 待确认 without caching, so a later routebook can try again.
      for (const field of pending) keep(field, 'budget', { reasonText: '本次核对额度已用完' });
      await step(name);
      continue;
    }
    if (first.answer?.ambiguous && place.status !== 'matched') {
      for (const field of pending) await remember(field, { status: 'kept', reason: 'ambiguous', reasonText: '同名地点不止一处' });
      await step(name);
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
      let seasonal = false;
      const pageConditions = [];
      for (const w of webs) {
        // Only URLs the search really returned; the ones the model named for this field first.
        const named = (w.answer?.[`${field}Sources`] ?? []).filter((u) => w.cited.has(u));
        const urls = [...new Set([...named, ...w.cited.keys()])]
          .map((u, order) => ({ u, order, official: isOfficialSource(u, w.cited.get(u) || '', name) }))
          .sort((x, y) => Number(y.official) - Number(x.official) || x.order - y.order)
          .map(({ u }) => u)
          .filter((u) => {
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
          if (page.ok && pageSupports(page.text, name, patterns)) {
            if (field === 'price' && pageHasSeasonalPrice(page.text, name)) seasonal = true;
            verified.push({ kind: 'web', url, title: page.title || w.cited.get(url) || '', domain, quote: evidenceQuote(page.text, name, patterns) });
            const conditions = extractConditions(page.text, name, { pageTitle: page.title || w.cited.get(url) || '' }).filter((c) =>
              field === 'price' ? c.kind !== 'seasonal-hours' : ['reservation', 'seasonal-hours'].includes(c.kind)
            );
            if (conditions.length) pageConditions.push({ conditions, url, domain });
          }
        }
      }
      const conditions = mergeConditions(pageConditions);
      // 分淡旺季：不填单个数字；两个来源核对过票价时，显示原文里的淡旺季说明。
      if (seasonal) {
        if (verified.length < 2) return { status: 'kept', reason: 'seasonal', reasonText: '票价分淡旺季，出发前按日期确认' };
        const at = retrievedAt();
        return {
          status: 'filled',
          value: '分淡旺季',
          display: `门票分淡旺季 · 来自${verified[0].title || verified[0].domain}等${verified.length}个来源 · 查询于${at.slice(0, 10)}`,
          sources: verified,
          retrievedAt: at,
          method: verified.length < 2 ? 'single-page' : 'pages',
          conditions
        };
      }
      const value = field === 'hours' ? /** @type {string} */ (canonical) : priceDisplay(canonical);
      const at = retrievedAt();
      if (field === 'hours' && amapHours && amapHours !== canonical) {
        return { status: 'kept', reason: 'conflict', reasonText: `各来源说法不一（高德 ${amapHours}，网页 ${canonical}）` };
      }
      if (field === 'hours' && amapHours === canonical && verified.length >= 1) {
        const sources = [{ kind: 'amap', url: place.poi.url, title: `高德地图 · ${place.poi.name}`, domain: 'amap.com' }, ...verified.slice(0, 2)];
        return {
          status: 'filled',
          value,
          display: display(field, value, sources, at),
          sources,
          retrievedAt: at,
          method: 'amap+page',
          ...(conditions.length ? { conditions } : {})
        };
      }
      if (verified.length >= minSources) {
        return {
          ...(verified.length < 2 ? { singleSource: true } : {}),
          status: 'filled',
          value,
          ...(field === 'price' ? { price: priceKey(canonical) } : {}),
          display: display(field, value, verified, at),
          sources: verified,
          retrievedAt: at,
          method: 'pages',
          ...(conditions.length ? { conditions } : {})
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
    await step(name);

    async function remember(field, entry) {
      const key = cacheKeyFor(city, name, field);
      if (entry.status === 'filled') counts.filled += 1;
      else counts.kept += 1;
      claims.push({ ...base, field, ...entry, cacheKey: key });
      if (ENRICH_CACHE_DAYS > 0) await store.putCache(key, entry, new Date(now() + ENRICH_CACHE_DAYS * 86400000).toISOString());
    }
  }
  await store.addSpend({ pages: counts.pages, amapCalls: counts.amapCalls }, now());
  const summary = {
    ...counts,
    usd: Number(counts.usd.toFixed(4)),
    stoppedBy: budget.stoppedBy,
    ...(budget.lastError ? { lastError: budget.lastError.slice(0, 200) } : {}),
    stopsDone: stopsTotal,
    stopsTotal,
    phase: 'done'
  };
  log({ event: 'enrich', routebookId: routebook.id, ...summary });
  return { claims, summary };
}

export { FIELD_LABEL };

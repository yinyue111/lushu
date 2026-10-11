// Sources for enrichment: AMap place search (structured) and a web search through the relay's
// Responses API (grok web_search). Neither result is trusted on its own; see engine.mjs.
import { AMAP_API_BASE_URL, AMAP_GEOCODE_KEY, ENRICH_API_KEY, ENRICH_BASE_URL, ENRICH_MODEL, ENRICH_SEARCH_TIMEOUT_MS } from '../config/index.mjs';
import { pacedAmapFetch } from '../geo/amap.mjs';
import { gcj02ToWgs84 } from '../geo/coordinates.mjs';

const ATTRACTION_TYPE = /风景名胜|公园|广场|博物馆|纪念馆|展览馆|美术馆|科技馆|文化宫|寺庙|道观|教堂|古镇|动物园|植物园|水族馆|特色商业街|步行街|旅游景点/;
const RESTAURANT_TYPE = /餐饮服务|茶艺馆|咖啡|酒吧|甜品/;

const haversine = (a, b) => {
  const r = Math.PI / 180;
  const x = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lng - a.lng) * r) / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(x));
};
const baseName = (name) =>
  String(name ?? '')
    .replace(/[（(].*$/, '')
    .replace(/(景区|风景区|步行街|-.*)$/, '')
    .trim();

/**
 * AMap v5 text search with the unique-match rule.
 * @returns {Promise<{ status: 'matched', poi: any } | { status: 'chain'|'restaurant'|'no-match'|'error', candidates?: string[] }>}
 */
export async function amapPlace({ name, city, lat, lng }, { fetchImpl = pacedAmapFetch, key = AMAP_GEOCODE_KEY, baseUrl = AMAP_API_BASE_URL } = {}) {
  if (!key) return { status: 'error' };
  const params = new URLSearchParams({ key, keywords: name, region: city, city_limit: 'true', show_fields: 'business', page_size: '10' });
  let data;
  try {
    const res = await fetchImpl(`${String(baseUrl).replace(/\/+$/, '')}/v5/place/text?${params}`, { signal: AbortSignal.timeout(8000) });
    data = res.ok ? await res.json() : null;
  } catch {
    data = null;
  }
  if (!data || String(data.status) !== '1') return { status: 'error' };
  const pois = (data.pois ?? []).map((p) => {
    const [gLng, gLat] = String(p.location ?? '')
      .split(',')
      .map(Number);
    const wgs = Number.isFinite(gLat) ? gcj02ToWgs84(gLat, gLng) : null;
    const dist = wgs && Number.isFinite(lat) && Number.isFinite(lng) ? haversine({ lat, lng }, wgs) : Infinity;
    return { ...p, dist };
  });
  const target = baseName(name);
  const same = pois.filter((p) => p.name === name || baseName(p.name) === target);
  // A chain: several branches of the same name. The guide did not say which one, so we never pick.
  const branches = same.filter((p) => /[（(][^）)]*店[）)]|店$/.test(p.name));
  if (branches.length > 1) return { status: 'chain', candidates: branches.slice(0, 5).map((p) => p.name) };
  const near = same.filter((p) => p.dist < 3000);
  const hit = near.length === 1 ? near[0] : near.length === 0 && same.length === 1 ? same[0] : null;
  if (!hit) return { status: 'no-match', candidates: pois.slice(0, 3).map((p) => p.name) };
  if (RESTAURANT_TYPE.test(hit.type ?? '') && !ATTRACTION_TYPE.test(hit.type ?? '')) return { status: 'restaurant' };
  const b = hit.business ?? {};
  return {
    status: 'matched',
    poi: {
      id: hit.id,
      name: hit.name,
      type: hit.type ?? '',
      attraction: ATTRACTION_TYPE.test(hit.type ?? ''),
      hours: b.opentime_week || b.opentime_today || '',
      url: `https://www.amap.com/place/${encodeURIComponent(hit.id)}`
    }
  };
}

/**
 * One web search for a place's ticket price and opening hours.
 * Only URLs the search itself returned (annotations / search sources) count as citations.
 * @returns {Promise<{ answer: any, cited: Map<string,string>, usd: number|null, searches: number }>}
 */
export async function webSearchPlace(
  { name, city, fields, variant = 0 },
  { fetchImpl = fetch, baseUrl = ENRICH_BASE_URL, apiKey = ENRICH_API_KEY, model = ENRICH_MODEL } = {}
) {
  const asks = [fields.includes('price') ? '门票价格（免费就写“免费”）' : '', fields.includes('hours') ? '开放时间' : ''].filter(Boolean).join('和');
  const input = [
    variant ? `请联网搜索 ${city}「${name}」的${asks}，优先找官方网站、政府或景区公告、主流新闻报道。` : `请联网搜索 ${city}「${name}」的${asks}。`,
    '只依据搜索到的网页原文，不要凭记忆；网页里没有就填 null。',
    '如果这个名字在当地对应多处地点、或是连锁店，返回 {"ambiguous": true}。',
    '只返回 JSON：{"price": "原文里的票价或免费，或 null", "priceSources": ["写着这个票价的网址"], "hours": "原文里的开放时间，如 07:30-17:30，或 null", "hoursSources": ["网址"]}'
  ].join('\n');
  const res = await fetchImpl(`${baseUrl}/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input, tools: [{ type: 'web_search' }] }),
    signal: AbortSignal.timeout(ENRICH_SEARCH_TIMEOUT_MS)
  });
  if (!res.ok) {
    const error = new Error(`web search HTTP ${res.status}`);
    // @ts-ignore
    error.retryable = res.status >= 500 || res.status === 429;
    throw error;
  }
  const data = await res.json();
  const cited = new Map();
  const add = (url, title) => {
    const u = String(url ?? '').startsWith('//') ? `https:${url}` : String(url ?? '');
    if (/^https?:\/\//.test(u)) cited.set(u, title || cited.get(u) || '');
  };
  let text = '';
  for (const item of data.output ?? []) {
    for (const source of item.action?.sources ?? []) add(source?.url, source?.title ?? '');
    if (item.type !== 'message') continue;
    for (const part of item.content ?? []) {
      text += part.text ?? '';
      for (const a of part.annotations ?? []) add(a?.url, a?.title && a.title !== a.url ? a.title : '');
    }
  }
  let answer = {};
  try {
    answer = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  } catch {
    answer = {};
  }
  const ticks = Number(data.usage?.cost_in_usd_ticks);
  return {
    answer,
    cited,
    usd: Number.isFinite(ticks) && ticks > 0 ? ticks / 1e10 : null,
    searches: Number(data.usage?.server_side_tool_usage_details?.web_search_calls) || 1
  };
}

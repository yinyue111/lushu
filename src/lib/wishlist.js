// 「想去清单」：平时刷到小红书/抖音好店或景点先随手记下，按城市自动归类，出发前一键排成顺路路书或直接塞进已有路书。
import { cityCenters, coordinateForName } from './coordinates.js';

const WISHLIST_PREFIX = 'trusted-routebook:wishlist:v1';

function storageKey(profileId = 'anonymous') {
  return `${WISHLIST_PREFIX}:${encodeURIComponent(String(profileId || 'anonymous'))}`;
}

/**
 * @param {string} [profileId]
 * @param {Storage} [storage]
 */
export function readWishlist(profileId = 'anonymous', storage = globalThis.localStorage) {
  if (!storage) return [];
  try {
    const raw = JSON.parse(storage.getItem(storageKey(profileId)) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw.filter((item) => item && typeof item.city === 'string' && typeof item.place === 'string' && item.place.trim());
  } catch {
    return [];
  }
}

/**
 * @param {string} profileId
 * @param {{ city: string, place: string, note?: string }} input
 * @param {Storage} [storage]
 */
export function addWishlistItem(profileId = 'anonymous', input = { city: '', place: '' }, storage = globalThis.localStorage) {
  const city = String(input?.city ?? '')
    .trim()
    .replace(/市$/, '');
  const place = String(input?.place ?? '').trim();
  const note = String(input?.note ?? '').trim();
  if (!city || !place || !storage) return readWishlist(profileId, storage);

  const existing = readWishlist(profileId, storage);
  const duplicate = existing.some((item) => item.city === city && item.place === place);
  if (duplicate) return existing;

  const entry = {
    id: `wish-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    city,
    place: place.slice(0, 48),
    note: note.slice(0, 120),
    createdAt: new Date().toISOString()
  };
  const next = [entry, ...existing].slice(0, 80);
  try {
    storage.setItem(storageKey(profileId), JSON.stringify(next));
  } catch {
    // 存储满时退回内存态
  }
  return next;
}

/**
 * @param {string} profileId
 * @param {string} itemId
 * @param {Storage} [storage]
 */
export function removeWishlistItem(profileId = 'anonymous', itemId = '', storage = globalThis.localStorage) {
  const existing = readWishlist(profileId, storage);
  const next = existing.filter((item) => item.id !== itemId);
  try {
    storage?.setItem(storageKey(profileId), JSON.stringify(next));
  } catch {
    // ignore
  }
  return next;
}

/**
 * 合并云端心愿单到本机存储（去重保留最新顺序，支持跨设备登录同步）。
 * @param {string} profileId
 * @param {any[]} cloudItems
 * @param {Storage} [storage]
 */
export function mergeWishlistFromCloud(profileId = 'anonymous', cloudItems = [], storage = globalThis.localStorage) {
  const local = readWishlist(profileId, storage);
  const merged = [];
  const seen = new Set();
  for (const item of [...local, ...(Array.isArray(cloudItems) ? cloudItems : [])]) {
    const city = String(item?.city ?? '')
      .trim()
      .replace(/市$/, '');
    const place = String(item?.place ?? '').trim();
    if (!city || !place) continue;
    const key = `${city}:${place}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({
      id: String(item.id || `wish-${merged.length + 1}`),
      city,
      place: place.slice(0, 48),
      note: String(item.note ?? '')
        .trim()
        .slice(0, 120),
      createdAt: String(item.createdAt || new Date().toISOString())
    });
    if (merged.length >= 80) break;
  }
  try {
    storage?.setItem(storageKey(profileId), JSON.stringify(merged));
  } catch {
    // ignore
  }
  return merged;
}

/**
 * @param {any[]} items
 */
export function groupWishlistByCity(items = []) {
  const map = new Map();
  for (const item of items) {
    if (!item?.city || !item?.place) continue;
    if (!map.has(item.city)) map.set(item.city, []);
    map.get(item.city).push(item);
  }
  return [...map.entries()].map(([city, list]) => ({ city, items: list }));
}

/**
 * 把某城市攒下的心愿地点拼成可直接送入生成向导的清晰攻略草稿。
 * @param {string} city
 * @param {any[]} items
 */
export function buildWishlistGuidePrompt(city, items = []) {
  const valid = (items || []).filter((i) => i?.place);
  if (!valid.length) return '';
  const lines = valid.map((item, idx) => `${idx + 1}. ${item.place}${item.note ? `（${item.note}）` : ''}`);
  return [`平时收藏的${city}想去清单：`, ...lines].join('\n');
}

function nextStopClockForDay(dayStops = []) {
  if (!dayStops.length) return '10:00';
  const last = dayStops.at(-1);
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(last?.time ?? '').trim());
  const baseMin = m ? Number(m[1]) * 60 + Number(m[2]) : 14 * 60;
  const stayMatch = /(\d+)\s*分钟/.exec(String(last?.stay ?? ''));
  const stayMin = stayMatch ? Number(stayMatch[1]) : 60;
  const nextMin = Math.min(20 * 60 + 30, baseMin + stayMin + 30);
  return `${String(Math.floor(nextMin / 60)).padStart(2, '0')}:${String(nextMin % 60).padStart(2, '0')}`;
}

/**
 * 将单个心愿单地点追加到已有个人草稿路书的指定天，返回新路书快照与顺路/节奏提示。
 * @param {any} routebook
 * @param {{ place: string, city?: string, note?: string }} wishItem
 * @param {string} [targetDay]
 */
export function appendWishlistItemToRoutebook(routebook, wishItem, targetDay = '') {
  const placeName = String(wishItem?.place ?? '').trim();
  if (!routebook || !placeName) return null;
  const stops = Array.isArray(routebook.stops) ? routebook.stops : [];
  const days = Array.isArray(routebook.days) && routebook.days.length ? routebook.days : [...new Set(stops.map((s) => s.day || 'Day 1').filter(Boolean))];
  const resolvedDay = targetDay && days.includes(targetDay) ? targetDay : days[0] || 'Day 1';
  const existingDuplicate = stops.find((s) => String(s?.name ?? '').trim() === placeName);
  if (existingDuplicate) {
    return {
      alreadyExists: true,
      routebook,
      addedStop: existingDuplicate,
      day: existingDuplicate.day || resolvedDay,
      dayStopCount: stops.filter((s) => (s.day || 'Day 1') === (existingDuplicate.day || resolvedDay)).length
    };
  }

  const city = String(routebook.city || wishItem?.city || '杭州')
    .trim()
    .replace(/市$/u, '');
  const canonical = coordinateForName(placeName, city);
  const center = cityCenters[city] || { lat: 30.2487, lng: 120.1551 };
  const dayStops = stops.filter((s) => (s.day || 'Day 1') === resolvedDay);
  const nextTime = nextStopClockForDay(dayStops);
  const newStop = {
    id: `wish_stop_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    day: resolvedDay,
    time: nextTime,
    name: placeName.slice(0, 48),
    area: canonical ? `${city}核对点位` : `${city}待确认片区`,
    stay: '60 分钟',
    cost: '价格待确认',
    verify: wishItem?.note ? `心愿单备注：${String(wishItem.note).slice(0, 60)}` : '从心愿单加入，出发前请留意开放时间',
    risk: canonical ? '' : '位置尚未精确匹配，出发前可在路书里点测算车程校准',
    lat: canonical ? canonical.lat : center.lat,
    lng: canonical ? canonical.lng : center.lng,
    geoConfidence: canonical ? 92 : 45,
    coordinateSystem: 'WGS84',
    coordinateSource: canonical ? 'known-poi' : 'user-edit',
    coordinatePrecision: canonical ? 'exact' : 'approximate',
    coordinateRadiusMeters: canonical ? 0 : 1500,
    navigationDisabled: !canonical,
    provenance: {
      origin: 'user-added',
      reviewedPoi: Boolean(canonical)
    }
  };

  // 将新站插入目标天末尾，保持按天分组连续
  const lastIdxOnDay = stops.reduce((acc, s, idx) => ((s.day || 'Day 1') === resolvedDay ? idx : acc), -1);
  const nextStops = lastIdxOnDay >= 0 ? [...stops.slice(0, lastIdxOnDay + 1), newStop, ...stops.slice(lastIdxOnDay + 1)] : [...stops, newStop];
  const nextDays = days.includes(resolvedDay) ? days : [...days, resolvedDay];
  const nowIso = new Date().toISOString();
  const updated = {
    ...routebook,
    days: nextDays,
    stops: nextStops,
    provider: {
      ...(routebook.provider ?? {}),
      editedAt: nowIso
    }
  };
  const dayStopCount = dayStops.length + 1;
  return {
    alreadyExists: false,
    routebook: updated,
    addedStop: newStop,
    day: resolvedDay,
    dayStopCount,
    crowdedDay: dayStopCount >= 5,
    exactCoords: Boolean(canonical)
  };
}

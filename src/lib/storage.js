const CACHE_PREFIX = 'trusted-routebook:v4';
const ROUTEBOOK_INDEX_KEY = `${CACHE_PREFIX}:routebook-index`;
const CLICK_PREFIX = 'trusted-routebook:clicks';
const CHECKIN_PREFIX = 'trusted-routebook:checkins';
const FAVORITE_PREFIX = 'trusted-routebook:favorites';
// 与 src/lib/tripSession.js 的 TRIP_SESSION_PREFIX 保持一致（迁移行中会话键用）。
const TRIP_SESSION_PREFIX = 'trusted-routebook:trip-session:v1';
const MAX_INDEXED_ROUTEBOOKS = 120;
const MAX_SCOPED_LIST_ROWS = 120;

export function getStoredRoutebooks(profileId = '') {
  const books = [];
  const seen = new Set();
  const indexedKeys = readRoutebookIndex();
  const indexedSet = new Set(indexedKeys);
  const collect = (data) => {
    if (!isRoutebookVisibleForProfile(data, profileId)) return;
    const id = routebookStorageId(data);
    if (seen.has(id)) return;
    seen.add(id);
    books.push(data);
  };
  for (const key of indexedKeys) {
    try {
      collect(JSON.parse(safeGetItem(key) ?? 'null'));
    } catch {
      /* skip corrupted */
    }
  }
  // 自愈：索引外的历史路书键补录进索引，之后的读取只需按索引定位，不再每次全量解析。
  const missingKeys = [];
  for (const key of safeStorageKeys()) {
    if (!key?.startsWith(`${CACHE_PREFIX}:`) || key === ROUTEBOOK_INDEX_KEY || indexedSet.has(key)) continue;
    try {
      const data = JSON.parse(safeGetItem(key) ?? 'null');
      if (!data?.city || !data?.stops?.length) continue;
      // :last 是 legacy 重复副本：只参与展示去重，不补录进索引（与迁移口径一致）。
      if (!key.endsWith(':last')) missingKeys.push(key);
      collect(data);
    } catch {
      /* skip corrupted */
    }
  }
  if (missingKeys.length) writeRoutebookIndex(insertKeysByRecency(indexedKeys, missingKeys).slice(0, MAX_INDEXED_ROUTEBOOKS));
  return books.sort((a, b) => {
    const tA = a.provider?.generatedAt ?? '';
    const tB = b.provider?.generatedAt ?? '';
    return tB.localeCompare(tA);
  });
}

export function getStoredRoutebookById(id) {
  const target = String(id ?? '').trim();
  if (!target) return null;
  // 常规存档按索引键直接定位，避免全量解析；publicId/id 与存储 id 不一致时才回退列表查找。
  try {
    const data = JSON.parse(safeGetItem(routebookPrimaryKey(target)) ?? 'null');
    if (data && (routebookStorageId(data) === target || data.publicId === target || data.id === target)) return data;
  } catch {
    /* fall through to list scan */
  }
  return getStoredRoutebooks().find((book) => routebookStorageId(book) === target || book.publicId === target || book.id === target) ?? null;
}

export function saveRoutebook(routebook, options = {}) {
  // 只有显式声明所有权的调用方（生成成功/复制成草稿/保存分享路书）才补 profileId，
  // 浏览他人路线时落库仅作缓存，不据为己有。profileId === 'anonymous' 视同未声明
  // 所有权：claimOwnership 时允许覆盖为当前身份，任何情况下 anonymous 不算 owner。
  const claimedOwner = routebook?.profileId && routebook.profileId !== 'anonymous';
  const normalized = claimedOwner || !options.claimOwnership ? routebook : { ...routebook, profileId: currentProfileId() };
  const key = routebookPrimaryKey(routebookStorageId(normalized));
  try {
    const serialized = JSON.stringify(normalized);
    const routeSaved = safeSetItem(key, serialized);
    // 写入失败时不把 key 记进索引，避免留下「索引里有、存储里无」的幻影键。
    if (!routeSaved) return false;
    const orderedKeys = [key, ...readRoutebookIndex().filter((item) => item !== key)];
    for (const evictedKey of orderedKeys.slice(MAX_INDEXED_ROUTEBOOKS)) safeRemoveItem(evictedKey);
    const indexSaved = writeRoutebookIndex(orderedKeys.slice(0, MAX_INDEXED_ROUTEBOOKS));
    return routeSaved && indexSaved;
  } catch {
    return false;
  }
}

export function safeWriteJsonStorage(key, value) {
  try {
    return safeSetItem(key, JSON.stringify(value));
  } catch {
    return false;
  }
}

export function deleteRoutebook(routebookOrId) {
  const target = typeof routebookOrId === 'string' ? getStoredRoutebookById(routebookOrId) : routebookOrId;
  if (!target) return false;
  const storageId = routebookStorageId(target);
  const removedKeys = new Set([routebookPrimaryKey(storageId)]);
  for (const key of readRoutebookIndex()) {
    if (removedKeys.has(key)) continue;
    try {
      const data = JSON.parse(safeGetItem(key) ?? 'null');
      if (data && routebookStorageId(data) === storageId) removedKeys.add(key);
    } catch {
      /* keep unrelated corrupted entries */
    }
  }
  const legacyKey = `${CACHE_PREFIX}:${encodeURIComponent(target.city ?? '杭州')}:last`;
  try {
    const legacy = JSON.parse(safeGetItem(legacyKey) ?? 'null');
    if (legacy && routebookStorageId(legacy) === storageId) removedKeys.add(legacyKey);
  } catch {
    /* legacy cache stays untouched when unreadable */
  }
  for (const key of removedKeys) safeRemoveItem(key);
  writeRoutebookIndex(readRoutebookIndex().filter((key) => !removedKeys.has(key)));
  return true;
}

export function listStoredCheckins() {
  const rows = [];
  for (const key of safeStorageKeys()) {
    if (!key?.startsWith(`${CHECKIN_PREFIX}:`)) continue;
    try {
      const items = JSON.parse(safeGetItem(key) ?? '[]');
      if (Array.isArray(items)) rows.push(...items.map((item) => ({ ...item, storageKey: key })));
    } catch {
      // Ignore corrupted local check-in rows.
    }
  }
  return rows.sort((a, b) => String(b.time ?? b.createdAt ?? '').localeCompare(String(a.time ?? a.createdAt ?? '')));
}

export function getStoredClicks() {
  const profileId = currentProfileId();
  const preferredKey = clickStorageKey(profileId);
  const rows = [];
  try {
    const scoped = JSON.parse(safeGetItem(preferredKey) ?? '[]');
    if (Array.isArray(scoped)) rows.push(...scoped);
  } catch {
    // Ignore corrupted scoped click rows.
  }
  try {
    const legacy = JSON.parse(safeGetItem(CLICK_PREFIX) ?? '[]');
    if (Array.isArray(legacy)) rows.push(...legacy.filter((item) => item?.profileId === profileId));
  } catch {
    // Ignore corrupted legacy click rows.
  }
  return rows;
}

export function getStoredFavorites(profileId = currentProfileId()) {
  const rows = [];
  try {
    const scoped = JSON.parse(safeGetItem(favoriteStorageKey(profileId)) ?? '[]');
    if (Array.isArray(scoped)) rows.push(...scoped);
  } catch {
    // Ignore corrupted scoped favorite rows.
  }
  try {
    const legacy = JSON.parse(safeGetItem(FAVORITE_PREFIX) ?? '[]');
    if (Array.isArray(legacy)) rows.push(...legacy.filter((item) => item?.profileId === profileId));
  } catch {
    // Ignore corrupted legacy favorite rows.
  }
  return rows.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
}

export function saveFavorite(favorite, profileId = currentProfileId()) {
  const normalized = {
    ...favorite,
    id: favorite?.id || `${favorite?.routeId || favorite?.routeTitle || 'route'}-${Date.now()}`,
    profileId,
    createdAt: favorite?.createdAt || new Date().toISOString()
  };
  const routeKey = favoriteRouteKey(normalized);
  const next = [normalized, ...getStoredFavorites(profileId).filter((item) => favoriteRouteKey(item) !== routeKey)].slice(0, 100);
  safeWriteJsonStorage(favoriteStorageKey(profileId), next);
  return normalized;
}

export function removeFavorite(favorite, profileId = currentProfileId()) {
  const routeKey = favoriteRouteKey(favorite);
  if (!routeKey) return false;
  let removed = false;
  try {
    const scoped = JSON.parse(safeGetItem(favoriteStorageKey(profileId)) ?? '[]');
    if (Array.isArray(scoped)) {
      const remaining = scoped.filter((item) => favoriteRouteKey(item) !== routeKey);
      if (remaining.length !== scoped.length) {
        safeWriteJsonStorage(favoriteStorageKey(profileId), remaining);
        removed = true;
      }
    }
  } catch {
    // Ignore corrupted scoped favorite rows.
  }
  try {
    const legacy = JSON.parse(safeGetItem(FAVORITE_PREFIX) ?? '[]');
    if (Array.isArray(legacy)) {
      const remaining = legacy.filter((item) => !(item?.profileId === profileId && favoriteRouteKey(item) === routeKey));
      if (remaining.length !== legacy.length) {
        safeWriteJsonStorage(FAVORITE_PREFIX, remaining);
        removed = true;
      }
    }
  } catch {
    // Ignore corrupted legacy favorite rows.
  }
  return removed;
}

export function migrateLocalProfileData(previousProfileId, nextProfileId) {
  const previousId = String(previousProfileId ?? '').trim();
  const nextId = String(nextProfileId ?? '').trim();
  if (!previousId || !nextId || previousId === nextId) return { routebooks: 0, checkins: 0, clicks: 0, favorites: 0, tripSessions: 0 };
  // 路书按前缀全扫描迁移（与 getStoredRoutebooks 一致，含 legacy :last 键）：
  // 索引外的路书也改写 profileId，并补录进索引；:last 键只原地改写，不再循环覆写。
  const migratedBookIds = new Set();
  const indexedKeys = readRoutebookIndex();
  const indexedSet = new Set(indexedKeys);
  const discoveredKeys = [];
  for (const key of safeStorageKeys()) {
    if (!key?.startsWith(`${CACHE_PREFIX}:`) || key === ROUTEBOOK_INDEX_KEY) continue;
    try {
      const data = JSON.parse(safeGetItem(key) ?? 'null');
      if (!data || !isRoutebookVisibleForProfile(data, previousId)) continue;
      const next = rewriteProfileFields(data, previousId, nextId);
      safeSetItem(key, JSON.stringify(next));
      migratedBookIds.add(routebookStorageId(next));
      if (!indexedSet.has(key) && !key.endsWith(':last')) discoveredKeys.push(key);
    } catch {
      // Ignore corrupted local routebooks during migration.
    }
  }
  if (discoveredKeys.length) writeRoutebookIndex(insertKeysByRecency(indexedKeys, discoveredKeys).slice(0, MAX_INDEXED_ROUTEBOOKS));
  const checkins = migrateScopedList(
    `${CHECKIN_PREFIX}:${previousId}:`,
    (key) => key.replace(`${CHECKIN_PREFIX}:${previousId}:`, `${CHECKIN_PREFIX}:${nextId}:`),
    previousId,
    nextId,
    { newestAtEnd: true }
  );
  const clicks =
    migrateSingleScopedList(clickStorageKey(previousId), clickStorageKey(nextId), previousId, nextId) +
    migrateLegacyRootRows(CLICK_PREFIX, clickStorageKey(nextId), previousId, nextId);
  const favorites =
    migrateSingleScopedList(favoriteStorageKey(previousId), favoriteStorageKey(nextId), previousId, nextId) +
    migrateLegacyRootRows(FAVORITE_PREFIX, favoriteStorageKey(nextId), previousId, nextId);
  const tripSessions = migrateTripSessionKeys(previousId, nextId);
  return { routebooks: migratedBookIds.size, checkins, clicks, favorites, tripSessions };
}

export function checkinStorageKey(routebook, profileId = currentProfileId()) {
  return `${CHECKIN_PREFIX}:${profileId}:${routebookKey(routebook)}`;
}

export function clickStorageKey(profileId = currentProfileId()) {
  return `${CLICK_PREFIX}:${profileId}`;
}

export function favoriteStorageKey(profileId = currentProfileId()) {
  return `${FAVORITE_PREFIX}:${profileId}`;
}

function routebookPrimaryKey(storageId) {
  return `${CACHE_PREFIX}:routebook:${encodeURIComponent(storageId)}`;
}

function routebookStorageId(routebook) {
  return (
    routebook?.publicId ||
    routebook?.id ||
    `${routebook?.city ?? 'city'}:${routebook?.title ?? 'route'}:${routebook?.provider?.generatedAt ?? routebook?.updatedAt ?? 'last'}`
  );
}

function readRoutebookIndex() {
  try {
    const rows = JSON.parse(safeGetItem(ROUTEBOOK_INDEX_KEY) ?? '[]');
    return Array.isArray(rows) ? rows.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function writeRoutebookIndex(keys) {
  return safeSetItem(ROUTEBOOK_INDEX_KEY, JSON.stringify([...new Set(keys)]));
}

function insertKeysByRecency(indexedKeys, newKeys) {
  // 自愈/迁移补录的键按书的时间插到索引合适位置（索引头部最新、尾部最旧先被淘汰），
  // 避免历史新书被一律排到索引末尾后当成最旧先淘汰。
  const timestamps = new Map();
  const timestampOf = (key) => {
    if (!timestamps.has(key)) timestamps.set(key, routebookIndexTimestamp(key));
    return timestamps.get(key);
  };
  const merged = [...indexedKeys];
  for (const key of newKeys) {
    const timestamp = timestampOf(key);
    const position = merged.findIndex((item) => timestampOf(item) < timestamp);
    if (position < 0) merged.push(key);
    else merged.splice(position, 0, key);
  }
  return merged;
}

function routebookIndexTimestamp(key) {
  try {
    const data = JSON.parse(safeGetItem(key) ?? 'null');
    return Math.max(0, ...[data?.provider?.generatedAt, data?.updatedAt].map((value) => Date.parse(value ?? '') || 0));
  } catch {
    return 0;
  }
}

function routebookKey(routebook) {
  return encodeURIComponent(routebook?.publicId || routebook?.id || `${routebook?.city ?? 'city'}:${routebook?.title ?? 'route'}`);
}

function isRoutebookVisibleForProfile(routebook, profileId = '') {
  if (!routebook?.city || !routebook?.stops?.length) return false;
  if (!profileId) return true;
  // 历史上被误标成本人 profileId 的浏览缓存无法与真实存档区分，保持可见即可，不做迁移清洗。
  return routebook.profileId === profileId || routebook.creator?.id === profileId;
}

function favoriteRouteKey(favorite) {
  return String(favorite?.routeId || favorite?.routeTitle || favorite?.id || '').trim();
}

function rewriteProfileFields(value, previousId, nextId) {
  const next = { ...value };
  if (next.profileId === previousId) next.profileId = nextId;
  if (next.creator?.id === previousId) next.creator = { ...next.creator, id: nextId };
  return next;
}

function migrateScopedList(prefix, nextKeyFor, previousId, nextId, options = {}) {
  let count = 0;
  for (const key of safeStorageKeys()) {
    if (!key?.startsWith(prefix)) continue;
    count += migrateSingleScopedList(key, nextKeyFor(key), previousId, nextId, options);
  }
  return count;
}

function migrateSingleScopedList(previousKey, nextKey, previousId, nextId, options = {}) {
  try {
    const rows = JSON.parse(safeGetItem(previousKey) ?? '[]');
    if (!Array.isArray(rows) || !rows.length) return 0;
    const migratedRows = rows.map((item) => rewriteProfileFields(item, previousId, nextId));
    const existing = JSON.parse(safeGetItem(nextKey) ?? '[]');
    const merged = Array.isArray(existing) ? [...migratedRows, ...existing] : migratedRows;
    // 打卡类列表存储序为旧→新，截断保留末尾（最新）；点击/收藏为新→旧，保留开头，
    // 确保目标账号最新记录不会被迁移合并截掉。
    const limited = options.newestAtEnd ? merged.slice(-MAX_SCOPED_LIST_ROWS) : merged.slice(0, MAX_SCOPED_LIST_ROWS);
    safeSetItem(nextKey, JSON.stringify(limited));
    safeRemoveItem(previousKey);
    return migratedRows.length;
  } catch {
    return 0;
  }
}

function migrateTripSessionKeys(previousId, nextId) {
  // 行中会话键按 profileId 前缀改写（key 构造与 src/lib/tripSession.js 一致）；
  // 目标身份已有同路线会话时保留目标侧，旧键仅删除不覆盖。
  const previousPrefix = `${TRIP_SESSION_PREFIX}:${encodeURIComponent(previousId)}:`;
  const nextPrefix = `${TRIP_SESSION_PREFIX}:${encodeURIComponent(nextId)}:`;
  let count = 0;
  for (const key of safeStorageKeys()) {
    if (!key?.startsWith(previousPrefix)) continue;
    const nextKey = `${nextPrefix}${key.slice(previousPrefix.length)}`;
    try {
      const session = JSON.parse(safeGetItem(key) ?? 'null');
      if (session && typeof session === 'object') {
        const migrated = rewriteProfileFields(session, previousId, nextId);
        // session.profileId 是 readTripSession 的校验字段：只有归属旧 id 的会话才搬到新前缀。
        if (migrated.profileId === nextId && safeGetItem(nextKey) === null) {
          safeSetItem(nextKey, JSON.stringify(migrated));
          count += 1;
        }
      }
      safeRemoveItem(key);
    } catch {
      // Ignore corrupted trip sessions during migration.
    }
  }
  return count;
}

function migrateLegacyRootRows(rootKey, nextKey, previousId, nextId) {
  // legacy 根键（未按 profile 作用域）里属于旧 id 的行也改写并搬入新作用域键。
  try {
    const rows = JSON.parse(safeGetItem(rootKey) ?? '[]');
    if (!Array.isArray(rows) || !rows.length) return 0;
    const matched = rows.filter((item) => item?.profileId === previousId);
    if (!matched.length) return 0;
    const remaining = rows.filter((item) => item?.profileId !== previousId);
    const migratedRows = matched.map((item) => rewriteProfileFields(item, previousId, nextId));
    const existing = JSON.parse(safeGetItem(nextKey) ?? '[]');
    const merged = Array.isArray(existing) ? [...migratedRows, ...existing] : migratedRows;
    safeSetItem(nextKey, JSON.stringify(merged.slice(0, MAX_SCOPED_LIST_ROWS)));
    if (remaining.length) safeSetItem(rootKey, JSON.stringify(remaining));
    else safeRemoveItem(rootKey);
    return migratedRows.length;
  } catch {
    return 0;
  }
}

function currentProfileId() {
  try {
    const profile = JSON.parse(safeGetItem('trusted-routebook:profile:v1') ?? '{}');
    return profile?.id || 'anonymous';
  } catch {
    return 'anonymous';
  }
}

function safeStorageKeys() {
  try {
    return Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)).filter(Boolean);
  } catch {
    return [];
  }
}

function safeGetItem(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetItem(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    // 配额或存储异常：按最旧路书淘汰一次后重试，仍失败则交由调用方提示「本地存储已满」。
    if (!evictOldestRoutebookEntry(key)) return false;
    try {
      localStorage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  }
}

function evictOldestRoutebookEntry(excludeKey) {
  const index = readRoutebookIndex();
  const removed = new Set();
  let evicted = false;
  for (let i = index.length - 1; i >= 0; i -= 1) {
    const candidate = index[i];
    if (!candidate || candidate === excludeKey || candidate === ROUTEBOOK_INDEX_KEY) continue;
    // 幻影键（索引里有、存储里无）删了也腾不出空间：从索引剔除后继续找下一个候选，
    // 直到真正删掉一个还有存储值的键才算淘汰成功。
    if (safeGetItem(candidate) === null) {
      removed.add(candidate);
      continue;
    }
    safeRemoveItem(candidate);
    removed.add(candidate);
    evicted = true;
    break;
  }
  if (removed.size) {
    try {
      // 直接写原始索引，避免与 safeSetItem 的淘汰重试互相递归。
      localStorage.setItem(ROUTEBOOK_INDEX_KEY, JSON.stringify(index.filter((item) => !removed.has(item))));
    } catch {
      // 索引写入失败时，下次 getStoredRoutebooks 会按前缀扫描自愈。
    }
  }
  return evicted;
}

function safeRemoveItem(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Storage may be unavailable in private or restricted contexts.
  }
}

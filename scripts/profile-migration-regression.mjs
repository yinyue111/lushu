import assert from 'node:assert/strict';

class MemoryStorage {
  constructor() {
    this.values = new Map();
  }

  get length() {
    return this.values.size;
  }

  key(index) {
    return [...this.values.keys()][index] ?? null;
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.values.set(String(key), String(value));
  }

  removeItem(key) {
    this.values.delete(String(key));
  }
}

globalThis.localStorage = new MemoryStorage();

const previousId = 'p_local_previous';
const nextId = 'p_server_stable';
const routeKey = 'trusted-routebook:v4:routebook:route-1';
// rank10 迁移语义变更后新增的覆盖场景：索引外路书键、legacy :last 键、legacy 根键行、目标账号已有打卡。
const orphanRouteKey = 'trusted-routebook:v4:routebook:route-2';
const legacyLastKey = `trusted-routebook:v4:${encodeURIComponent('杭州')}:last`;
const indexKey = 'trusted-routebook:v4:routebook-index';
localStorage.setItem('trusted-routebook:profile:v1', JSON.stringify({ id: previousId, homeCity: '杭州' }));
localStorage.setItem(indexKey, JSON.stringify([routeKey]));
localStorage.setItem(routeKey, JSON.stringify({
  id: 'route-1',
  publicId: 'route-1',
  profileId: previousId,
  creator: { id: previousId, name: '本机用户' },
  city: '杭州',
  stops: [{ id: 'a' }, { id: 'b' }]
}));
// 索引外的路书（历史版本只写主键未写索引）也要被迁移并补录进索引。
localStorage.setItem(orphanRouteKey, JSON.stringify({
  id: 'route-2',
  publicId: 'route-2',
  profileId: previousId,
  city: '杭州',
  stops: [{ id: 'c' }, { id: 'd' }]
}));
// legacy :last 键与 route-1 是同一本书：原地改写 profileId，但不重复计数、不进索引。
localStorage.setItem(legacyLastKey, JSON.stringify({
  id: 'route-1',
  publicId: 'route-1',
  profileId: previousId,
  city: '杭州',
  stops: [{ id: 'a' }, { id: 'b' }]
}));
localStorage.setItem(`trusted-routebook:checkins:${previousId}:route-1`, JSON.stringify([{ id: 'c1', profileId: previousId, time: '2026-07-10T08:00:00.000Z' }]));
// 目标账号已有的最新打卡不能被合并截断丢掉（存储序旧→新，最新在末尾）。
localStorage.setItem(`trusted-routebook:checkins:${nextId}:route-1`, JSON.stringify([{ id: 'c-target-latest', profileId: nextId, time: '2026-07-20T08:00:00.000Z' }]));
// 行中会话键（trip-session，前缀口径与 src/lib/tripSession.js 一致）也要随身份迁移：
// 旧 id 前缀键改写为新 id 前缀，内部 profileId 同步改写（readTripSession 的校验字段）。
const tripSessionPreviousKey = `trusted-routebook:trip-session:v1:${encodeURIComponent(previousId)}:route-1`;
const tripSessionNextKey = `trusted-routebook:trip-session:v1:${encodeURIComponent(nextId)}:route-1`;
localStorage.setItem(tripSessionPreviousKey, JSON.stringify({
  version: 1,
  routeId: 'route-1',
  profileId: previousId,
  stops: [{ id: 'a' }, { id: 'b' }],
  createdAt: '2026-07-10T08:00:00.000Z',
  updatedAt: '2026-07-10T09:00:00.000Z'
}));
localStorage.setItem(`trusted-routebook:clicks:${previousId}`, JSON.stringify([{ id: 'k1', profileId: previousId }]));
localStorage.setItem(`trusted-routebook:favorites:${previousId}`, JSON.stringify([{ id: 'f1', profileId: previousId }]));
// legacy 根键（未按 profile 作用域）里属于旧 id 的行要改写并搬入新作用域键，其他人的行原样保留。
localStorage.setItem('trusted-routebook:clicks', JSON.stringify([
  { id: 'k-legacy', profileId: previousId },
  { id: 'k-other', profileId: 'p_someone_else' }
]));
localStorage.setItem('trusted-routebook:favorites', JSON.stringify([{ id: 'f-legacy', profileId: previousId }]));

const { createProfileSyncCode, parseProfileSyncCode } = await import('../src/lib/profile.js');
const { adoptServerProfile } = await import('../src/lib/profileSync.js');
const adoption = adoptServerProfile({
  id: nextId,
  previousLocalId: previousId,
  profileAccessToken: 'profile-token-1234567890',
  homeCity: '杭州'
}, { id: previousId, homeCity: '杭州' });

assert.equal(adoption.profile.id, nextId);
// 断言更新说明（rank10 迁移语义刻意变更）：
// - routebooks: 2 = route-1（主键 + :last 去重后记一次）+ route-2（索引外键也迁移）
// - clicks/favorites: 各 +1 来自 legacy 根键中 profileId === 旧 id 的行
// - tripSessions: 1（本轮 E 项刻意变更：迁移清单补 trip-session key），
//   migration 增加 tripSessions 计数，migratedCount 相应 7 → 8。
assert.equal(adoption.migratedCount, 8);
assert.deepEqual(adoption.migration, { routebooks: 2, checkins: 1, clicks: 2, favorites: 2, tripSessions: 1 });
assert.equal(JSON.parse(localStorage.getItem(routeKey)).profileId, nextId);
assert.equal(JSON.parse(localStorage.getItem(routeKey)).creator.id, nextId);
assert.equal(JSON.parse(localStorage.getItem(orphanRouteKey)).profileId, nextId, '索引外路书也要改写 profileId');
assert.equal(JSON.parse(localStorage.getItem(legacyLastKey)).profileId, nextId, 'legacy :last 键要原地改写 profileId');
const migratedIndex = JSON.parse(localStorage.getItem(indexKey));
assert.ok(migratedIndex.includes(orphanRouteKey), '索引外路书要补录进索引');
assert.ok(!migratedIndex.includes(legacyLastKey), ':last 键是重复副本，不应进索引');
assert.equal(localStorage.getItem(`trusted-routebook:checkins:${previousId}:route-1`), null);
const mergedCheckins = JSON.parse(localStorage.getItem(`trusted-routebook:checkins:${nextId}:route-1`));
assert.equal(mergedCheckins.length, 2);
assert.equal(mergedCheckins[0].profileId, nextId);
assert.equal(mergedCheckins.at(-1).id, 'c-target-latest', '目标账号最新打卡必须保留在末尾（旧→新存储序）');
const mergedClicks = JSON.parse(localStorage.getItem(`trusted-routebook:clicks:${nextId}`));
assert.deepEqual(mergedClicks.map((row) => row.id).sort(), ['k-legacy', 'k1']);
assert.ok(mergedClicks.every((row) => row.profileId === nextId));
assert.deepEqual(JSON.parse(localStorage.getItem('trusted-routebook:clicks')), [{ id: 'k-other', profileId: 'p_someone_else' }], 'legacy 根键里其他人的行要原样保留');
const mergedFavorites = JSON.parse(localStorage.getItem(`trusted-routebook:favorites:${nextId}`));
assert.deepEqual(mergedFavorites.map((row) => row.id).sort(), ['f-legacy', 'f1']);
assert.ok(mergedFavorites.every((row) => row.profileId === nextId));
assert.equal(localStorage.getItem('trusted-routebook:favorites'), null, 'legacy 根键全部迁走后应删除');
assert.equal(localStorage.getItem(tripSessionPreviousKey), null, '旧身份前缀的行中会话键要删除');
const migratedTripSession = JSON.parse(localStorage.getItem(tripSessionNextKey));
assert.equal(migratedTripSession.profileId, nextId, '行中会话要改写 profileId 并落到新身份前缀键');
assert.equal(migratedTripSession.routeId, 'route-1');
assert.equal(migratedTripSession.stops.length, 2, '行中会话 stops 迁移后保持原样');
assert.equal(JSON.parse(localStorage.getItem('trusted-routebook:profile:v1')).id, nextId);

const syncCode = createProfileSyncCode(adoption.profile);
assert.match(syncCode, /^trb1_/);
assert.deepEqual(parseProfileSyncCode(syncCode), {
  profileId: nextId,
  profileAccessToken: 'profile-token-1234567890'
});
assert.throws(() => parseProfileSyncCode('trb1_broken'), /恢复码无效或已损坏/);

console.log(JSON.stringify({ ok: true, migration: adoption.migration, syncCode: true }));

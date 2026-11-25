import assert from 'node:assert/strict';
import test from 'node:test';
import { suggestCompactPlan } from '../../src/components/Trip/tripModel.js';
import { buildCompanionSummaryText, readCompanionState, writeCompanionState } from '../../src/lib/companionFeedback.js';
import { addWishlistItem, buildWishlistGuidePrompt, groupWishlistByCity, readWishlist, removeWishlistItem } from '../../src/lib/wishlist.js';

function createMemoryStorage() {
  const store = new Map();
  return /** @type {Storage} */ ({
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    key(index) {
      return [...store.keys()][index] ?? null;
    },
    removeItem(key) {
      store.delete(key);
    },
    setItem(key, value) {
      store.set(key, String(value));
    }
  });
}

test('suggestCompactPlan prefers elastic dining/buffer stops over pre-reserved museums', () => {
  const stops = [
    { id: 's1', day: 'Day 1', name: '中国丝绸博物馆', stay: '120 分钟', verify: '需提前在公众号实名预约' },
    { id: 's2', day: 'Day 1', name: '南宋御街小吃店', stay: '90 分钟', verify: '餐饮缓冲点' },
    { id: 's3', day: 'Day 1', name: '柳浪闻莺', stay: '60 分钟', verify: '傍晚收尾看日落' }
  ];
  const suggestion = suggestCompactPlan(stops, 0, new Map());
  assert.ok(suggestion);
  assert.equal(suggestion.stop.id, 's2');
  assert.equal(suggestion.savedMinutes, 90);
  assert.match(suggestion.reason, /餐饮|缓冲/);
});

test('companionFeedback persists unlisted friend votes and claims and formats group summary', () => {
  const mem = createMemoryStorage();
  writeCompanionState('rb-123', { votes: { s1: 'want', s2: 'skip' }, claims: ['s1:reservation'] }, mem);
  const loaded = readCompanionState('rb-123', mem);
  assert.equal(loaded.votes.s1, 'want');
  assert.deepEqual(loaded.claims, ['s1:reservation']);

  const text = buildCompanionSummaryText(
    {
      city: '杭州',
      stops: [
        { id: 's1', name: '中国丝绸博物馆' },
        { id: 's2', name: '南宋御街' }
      ]
    },
    loaded,
    [{ stopName: '中国丝绸博物馆', item: { key: 's1:reservation', label: '可能要预约' } }]
  );
  assert.match(text, /想重点去：中国丝绸博物馆/);
  assert.match(text, /可以先不去：南宋御街/);
  assert.match(text, /我来负责准备：中国丝绸博物馆（可能要预约）/);
});

test('wishlist stores items by profile, groups by city, and builds a clean builder prompt', () => {
  const mem = createMemoryStorage();
  addWishlistItem('p1', { city: '杭州市', place: '法喜寺', note: '吃斋饭' }, mem);
  addWishlistItem('p1', { city: '杭州', place: '茅家埠' }, mem);
  addWishlistItem('p1', { city: '苏州', place: '拙政园' }, mem);

  const all = readWishlist('p1', mem);
  assert.equal(all.length, 3);

  const groups = groupWishlistByCity(all);
  assert.equal(groups.length, 2);
  const hz = groups.find((g) => g.city === '杭州');
  assert.equal(hz?.items.length, 2);

  const prompt = buildWishlistGuidePrompt('杭州', hz?.items);
  assert.match(prompt, /平时收藏的杭州想去清单/);
  assert.match(prompt, /法喜寺（吃斋饭）/);

  const afterRemove = removeWishlistItem('p1', all[0].id, mem);
  assert.equal(afterRemove.length, 2);
});

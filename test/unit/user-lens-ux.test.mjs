import assert from 'node:assert/strict';
import test from 'node:test';
import { curatedRouteToRoutebook, curatedRoutes } from '../../src/lib/content.js';
import { costDisplay } from '../../src/lib/cost.js';
import { collectRouteConfirmEntries, confirmItemsForStop } from '../../src/lib/confirmChecklist.js';
import { buildReview } from '../../src/components/Trip/tripModel.js';
import { listTripSessions, saveTripSession, tripRoutebookId } from '../../src/lib/tripSession.js';

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

test('curated routes preserve editorial price display and exclude pacing advice from confirm checklist', () => {
  const hangzhouCurated = curatedRoutes.find((r) => r.city === '杭州') ?? curatedRoutes[0];
  assert.ok(hangzhouCurated, 'expected at least one featured curated route');

  const book = curatedRouteToRoutebook(hangzhouCurated);
  assert.ok(book.stops.length > 0);

  for (const stop of book.stops) {
    assert.equal(stop.provenance?.origin, 'editorial');
    assert.equal(stop.provenance?.reviewedPoi, true);
    const price = costDisplay(stop);
    assert.equal(price.pending, false, `editorial stop ${stop.name} should not mark price as pending`);
  }

  const entries = collectRouteConfirmEntries(book);
  for (const entry of entries) {
    assert.equal(/编辑建议|拍照效果/.test(entry.item.detail), false, `pacing advice leaked into checklist: ${entry.item.detail}`);
  }

  const realWarningItems = confirmItemsForStop(
    {
      id: 's-museum',
      name: '中国丝绸博物馆',
      lat: 30.224,
      lng: 120.145,
      reviewedPoi: true,
      provenance: { origin: 'editorial' },
      cost: '免费',
      verify: '编辑建议：上午光线好，顺路慢逛',
      risk: '周一闭馆，请提前预约'
    },
    { city: '杭州' }
  );
  assert.equal(
    realWarningItems.some((item) => item.kind === 'reservation'),
    true
  );
  assert.equal(
    realWarningItems.some((item) => item.kind === 'hours'),
    true
  );
  assert.equal(
    realWarningItems.some((item) => item.kind === 'note' && /编辑建议/.test(item.detail)),
    false
  );
});

test('TripView header review copy speaks traveler language before and during checkins', () => {
  const stops = [
    { id: 's1', day: 'Day 1', name: '河坊街' },
    { id: 's2', day: 'Day 1', name: '南宋御街' },
    { id: 's3', day: 'Day 2', name: '灵隐寺' }
  ];
  const initialCopy = buildReview([], stops, stops[0], stops[1]);
  assert.equal(initialCopy, 'Day 1 · 下一站 南宋御街');
  assert.equal(/沉淀完成度/.test(initialCopy), false);

  const midCopy = buildReview([{ stopId: 's1', localStopKey: 's1', status: 'visited', clientSyncStatus: 'queued' }], stops, stops[1], stops[2]);
  assert.equal(midCopy, '已走 1/3 站 · 下一站 灵隐寺');
});

test('tripRoutebookId matches active trip sessions for both local-only and cloud routebooks', () => {
  const prevStorage = globalThis.localStorage;
  const mem = createMemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', { value: mem, configurable: true, writable: true });
  try {
    const localDraft = {
      city: '杭州',
      title: '西湖慢走两日',
      stops: [
        { id: 's1', day: 'Day 1', name: '断桥残雪' },
        { id: 's2', day: 'Day 1', name: '平湖秋月' }
      ]
    };
    const ok = saveTripSession(localDraft, 'prof-1', {
      stops: [
        { id: 's1', day: 'Day 1', name: '断桥残雪', tripStatus: 'visited' },
        { id: 's2', day: 'Day 1', name: '平湖秋月' }
      ],
      currentStopId: 's2'
    });
    assert.equal(ok, true);

    const sessions = listTripSessions('prof-1', mem);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].routeId, tripRoutebookId(localDraft));
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { value: prevStorage, configurable: true, writable: true });
  }
});

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { JZH_CITIES } from '../../src/lib/chinaCities.js';
import { coordinateForName } from '../../src/lib/coordinates.js';
import { transitHubsForCity } from '../../src/components/Builder/builderModel.js';
import { isScheduledMealStop, reorderStopsByMode } from '../../src/lib/routeModes.js';
import { retimeReorderedDays } from '../../src/lib/stopTiming.js';
import { parseAdjustIntent } from '../../src/lib/adjustIntents.js';
import { proposeDayPatch } from '../../server/ai/patchRoutebook.mjs';
import { buildAmapNearbyFoodUrl, buildNearbyDining } from '../../src/lib/nearbyRecommendations.js';
import { detectClosedWeekdays, extractReservationLeadHint } from '../../src/lib/preTripAdvisor.js';
import { calculateExpenseSplit, readExpenseState } from '../../src/lib/expenseSplit.js';
import { mergeWishlistFromCloud } from '../../src/lib/wishlist.js';
import { buildTripIcsContent, mergeTripRemindersFromCloud } from '../../src/lib/reminders.js';
import { buildStopNavigationDescriptor } from '../../src/lib/navigationAdapter.js';
import { buildReviewSlideDeckModel } from '../../src/lib/reviewNote.js';
import { buildJourneyBehavior, CLIENT_JOURNEY_EVENTS } from '../../server/analytics/funnelEvents.mjs';
import { fetchCityWeatherForecast, setWeatherFetcherForTests } from '../../server/geo/weather.mjs';
import { startServer } from '../helpers/server.mjs';
import { authEnv, createClient } from '../helpers/accounts.mjs';

test('Phase 1: all 25 JZH cities have concrete transit hubs with verified coordinates', () => {
  assert.equal(JZH_CITIES.length, 25);
  for (const city of JZH_CITIES) {
    const hubs = transitHubsForCity(city);
    assert.ok(hubs.length >= 1, `${city} should have at least 1 concrete hub`);
    assert.ok(!hubs.includes('高铁站'), `${city} should not fall back to generic placeholder`);
    const coord = coordinateForName(hubs[0], city);
    assert.ok(coord && Number.isFinite(coord.lat) && Number.isFinite(coord.lng), `${city} hub ${hubs[0]} should have coordinates`);
  }
});

test('Phase 1: reorderStopsByMode + retimeReorderedDays keep dinner in evening slot on rainy mode and anchor to hubs', () => {
  const stops = [
    { id: 's1', day: 'Day 1', time: '09:30', stay: '90 分钟', name: '白堤漫步', area: '西湖', lat: 30.258, lng: 120.151, geoConfidence: 90 },
    {
      id: 'm1',
      day: 'Day 1',
      time: '12:00',
      stay: '60 分钟',
      name: '知味观午餐',
      area: '湖滨',
      costInfo: { unit: 'meal' },
      lat: 30.2528,
      lng: 120.1636,
      geoConfidence: 90
    },
    { id: 's2', day: 'Day 1', time: '14:30', stay: '90 分钟', name: '浙江省博物馆', area: '孤山', lat: 30.254, lng: 120.144, geoConfidence: 90 },
    {
      id: 'm2',
      day: 'Day 1',
      time: '18:30',
      stay: '75 分钟',
      name: '奎元馆晚饭',
      area: '上城',
      lat: 30.2478,
      lng: 120.1695,
      geoConfidence: 90
    }
  ];
  assert.equal(isScheduledMealStop(stops[1]), true);
  assert.equal(isScheduledMealStop(stops[3]), true);
  assert.equal(isScheduledMealStop(stops[2]), false);

  const constraints = { arrivalTime: '10:00', arrivalHub: '杭州东站', departureTime: '20:30', departureHub: '杭州西站' };
  const reordered = reorderStopsByMode(stops, '雨天', { preferredDays: ['Day 1'], constraints, city: '杭州' });
  const retimed = retimeReorderedDays(reordered, ['Day 1'], { constraints, allDays: ['Day 1'] });

  // Indoor museum moves to morning slot 0; lunch stays at index 1; outdoor walk moves to afternoon index 2; dinner stays at index 3!
  assert.equal(retimed[0].name, '浙江省博物馆');
  assert.equal(retimed[1].name, '知味观午餐');
  assert.equal(retimed[2].name, '白堤漫步');
  assert.equal(retimed[3].name, '奎元馆晚饭');
  assert.equal(retimed[0].time, '10:30'); // shifted after 10:00 arrival + 30m buffer
  assert.ok(retimed[3].time.startsWith('18:') || retimed[3].time.startsWith('19:'), `dinner kept in evening: ${retimed[3].time}`);
});

test('Phase 1: proposeDayPatch injects constraints into prompt and shifts Day 1 stop if model outputs before arrival buffer', async () => {
  let capturedPrompt = '';
  const routebook = {
    id: 'rb-constraints-patch',
    city: '杭州',
    days: ['Day 1', 'Day 2'],
    constraints: {
      arrivalTime: '14:00',
      arrivalHub: '杭州东站',
      departureTime: '17:00',
      departureHub: '杭州西站',
      mealPlan: '留出正餐时段',
      mustGo: '法喜寺',
      avoid: '河坊街',
      accommodationArea: '凤起路地铁站'
    },
    stops: [
      { id: 'a1', day: 'Day 1', time: '15:00', name: '柳浪闻莺', stay: '60 分钟', cost: '免费', area: '西湖' },
      { id: 'a2', day: 'Day 2', time: '09:30', name: '法喜寺', stay: '90 分钟', cost: '10 元', area: '天竺' }
    ]
  };
  const { proposal } = await proposeDayPatch(
    routebook,
    { type: 'all', instruction: '整体节奏调慢一点' },
    {
      modelCaller: async ({ prompt }) => {
        capturedPrompt = prompt;
        return {
          summary: '放慢游览节奏',
          stops: [
            { day: 'Day 1', time: '09:00', name: '柳浪闻莺', stay: '60 分钟', cost: '免费', area: '西湖' },
            { day: 'Day 2', time: '10:00', name: '法喜寺', stay: '90 分钟', cost: '10 元', area: '天竺' }
          ]
        };
      }
    }
  );
  assert.match(capturedPrompt, /14:00 到达「杭州东站」/);
  assert.match(capturedPrompt, /17:00 返程（杭州西站）/);
  assert.match(capturedPrompt, /必去保留点：法喜寺/);
  assert.match(capturedPrompt, /明确避开：河坊街/);
  assert.equal(proposal.stops[0].time, '14:45');
});

test('Phase 1: parseAdjustIntent handles natural L1 mode reorder and L1 transit window update', () => {
  const ctx = { days: ['Day 1', 'Day 2'], stopNames: ['法喜寺', '柳浪闻莺'], activeDay: 'Day 1' };
  const rainy = parseAdjustIntent('明天好像要下雨，帮我换成雨天室内方案吧', ctx);
  assert.equal(rainy?.kind, 'mode_reorder');
  assert.equal(rainy?.level, 'L1');
  assert.equal(rainy?.params.mode, '雨天');

  const transit = parseAdjustIntent('高铁改签到 14:30 到杭州东站', ctx);
  assert.equal(transit?.kind, 'update_transit_window');
  assert.equal(transit?.level, 'L1');
  assert.deepEqual(transit?.params, { arrivalTime: '14:30', arrivalHub: '杭州东站' });
});

test('Phase 1: nearby dining uses verified catalog without hardcoded prices, and preTripAdvisor detects Monday closures', () => {
  const current = { id: 'cur', name: '柳浪闻莺', city: '杭州', lat: 30.242, lng: 120.1617, geoConfidence: 90, coordinatePrecision: 'exact' };
  const dining = buildNearbyDining({
    current,
    routebook: { city: '杭州', stops: [current] },
    catalogDining: [{ poiId: 'poi-hz-zhiweiguan-hubin', city: '杭州', name: '知味观·湖滨总店', lat: 30.2528, lng: 120.1636, note: '价格以门店菜单为准' }]
  });
  assert.equal(dining.length, 1);
  assert.doesNotMatch(dining[0].reason, /人均约\s*\d+\s*元/);
  assert.match(buildAmapNearbyFoodUrl(current, '杭州'), /uri\.amap\.com\/search/);

  assert.deepEqual(detectClosedWeekdays({ name: '总统府' }).weekdays, [1]);
  assert.match(extractReservationLeadHint({ name: '南京博物院' }), /提前 7 天/);
});

test('Phase 2 & 3: pure helpers for ICS multi-events, cloud asset merge, navigation adapter, slide deck, weather & journey funnel', async () => {
  const ics = buildTripIcsContent({
    id: 'rb-ics',
    city: '南京',
    title: '南京两日游',
    travelDate: '2026-12-05',
    days: ['Day 1', 'Day 2'],
    constraints: { departureTime: '18:30', departureHub: '南京南站' },
    stops: [
      { id: '1', day: 'Day 1', time: '09:30', name: '南京博物院', stay: '120 分钟', verify: '需提前预约' },
      { id: '2', day: 'Day 2', time: '14:00', name: '老门东', stay: '90 分钟' }
    ]
  });
  assert.match(ics, /UID:booking-rb-ics@trusted-routebook/);
  assert.match(ics, /UID:stop-1-rb-ics@trusted-routebook/);
  assert.match(ics, /UID:departure-rb-ics@trusted-routebook/);
  assert.match(ics, /BEGIN:VALARM/);

  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  const mergedWish = mergeWishlistFromCloud('u1', [{ id: 'w1', city: '苏州', place: '拙政园', note: '早起去' }], /** @type {any} */ (storage));
  assert.equal(mergedWish.length, 1);
  assert.equal(mergedWish[0].place, '拙政园');
  const mergedRem = mergeTripRemindersFromCloud([{ routeId: 'rb-1', title: '苏州行', city: '苏州', date: '2026-12-10' }]);
  assert.ok(mergedRem.some((r) => r.routeId === 'rb-1'));

  const nav = buildStopNavigationDescriptor({ name: '拙政园', lat: 31.3243, lng: 120.6292, geoConfidence: 92, coordinatePrecision: 'exact' }, '苏州', 'walk');
  assert.equal(nav.navigable, true);
  assert.equal(nav.miniProgramLocation?.name, '拙政园');

  const deck = buildReviewSlideDeckModel(
    { city: '苏州', title: '苏州园林慢游' },
    [{ id: 's1', day: 'Day 1', time: '09:00', name: '拙政园' }],
    new Map([['s1', { worth: '值得', cost: '80 元', comment: '很美' }]])
  );
  assert.equal(deck.cover.aspectRatio, '3:4');
  assert.equal(deck.slides.length, 1);

  setWeatherFetcherForTests(async () => ({
    forecasts: [{ casts: [{ date: '2026-11-26', dayweather: '中雨', nightweather: '小雨', daytemp: '14', nighttemp: '9' }] }]
  }));
  const weather = await fetchCityWeatherForecast('杭州');
  assert.equal(weather.available, true);
  assert.equal(weather.forecasts[0].rainy, true);
  setWeatherFetcherForTests(null);

  assert.equal(CLIENT_JOURNEY_EVENTS.size, 8);
  const jb = buildJourneyBehavior([
    { event: 'trip_start', key: 'k1', createdAt: new Date().toISOString() },
    { event: 'expense_add', key: 'k1', createdAt: new Date().toISOString() },
    { event: 'expense_add', key: 'k2', createdAt: new Date().toISOString() }
  ]);
  assert.deepEqual(jb.expense_add, { people: 2, count: 2 });
});

test('End-to-end API integration: companion trip-sessions stream, link revoke isolation, shared AA ledger, profile assets & Bearer token auth', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'lushu-v9-test-'));
  const server = await startServer({
    dataDir,
    env: authEnv('login', {
      REGISTRATION_MODE: 'open',
      MODERATION_PROVIDER: 'keyword'
    })
  });
  try {
    const client = createClient(server.baseUrl);
    const reg = await client.register('13900008899', 'test-pass-123456');
    assert.equal(reg.status, 200);
    const profileId = reg.data.account.profileId;

    // 1) Exchange session for Bearer token (Mini-Program / App auth) & verify Bearer works without Cookie
    const tokRes = await client.post('/api/auth/token', {});
    assert.equal(tokRes.status, 200);
    assert.equal(tokRes.data.tokenType, 'Bearer');
    const bearerToken = tokRes.data.accessToken;
    assert.equal(bearerToken.length, 43);

    const meBearer = await fetch(`${server.baseUrl}/api/auth/me`, {
      headers: { authorization: `Bearer ${bearerToken}` }
    });
    assert.equal(meBearer.status, 200);
    const meJson = await meBearer.json();
    assert.equal(meJson.account?.profileId, profileId);

    // WeChat mini-program endpoint responds with 501 WECHAT_MINI_NOT_CONFIGURED when AppID is unset
    const wxRes = await fetch(`${server.baseUrl}/api/auth/wechat-mini`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'wx-mock-code' })
    });
    assert.equal(wxRes.status, 501);

    // 2) Sync wishlist & tripReminders via Bearer token on /api/profile/assets
    const saveAssetsRes = await fetch(`${server.baseUrl}/api/profile/assets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearerToken}` },
      body: JSON.stringify({
        profileId,
        wishlist: [{ id: 'w-nj-1', city: '南京', place: '南京博物院', note: '必看特展' }],
        tripReminders: [{ routeId: 'rb-shared-v9', title: '南京周末游', city: '南京', date: '2026-12-12' }]
      })
    });
    assert.equal(saveAssetsRes.status, 200);
    const getAssetsRes = await fetch(`${server.baseUrl}/api/profile/assets?profileId=${encodeURIComponent(profileId)}`, {
      headers: { authorization: `Bearer ${bearerToken}` }
    });
    const assetsJson = await getAssetsRes.json();
    assert.equal(assetsJson.wishlist.length, 1);
    assert.equal(assetsJson.tripReminders.length, 1);

    // 3) Save draft routebook, sync owner expenseLedger, open friend link, submit companion vote + shared expense
    const saveRb = await client.post('/api/routebooks', {
      id: 'rb-shared-v9',
      publicId: 'rb-shared-v9',
      profileId,
      title: '南京两日好友同行',
      city: '南京',
      days: ['Day 1'],
      stops: [
        { id: 'st-1', day: 'Day 1', time: '09:30', name: '南京博物院', stay: '120 分钟', cost: '免费' },
        { id: 'st-2', day: 'Day 1', time: '14:00', name: '老门东', stay: '90 分钟', cost: '免费' }
      ]
    });
    assert.equal(saveRb.status, 200);

    const expSync = await client.post('/api/routebooks/rb-shared-v9/expenses', {
      profileId,
      expenseLedger: {
        travelers: ['我', '小林'],
        extraExpenses: [{ id: 'own-1', title: '高铁站打车', amount: 40, paidBy: '我', splitWith: ['我', '小林'] }]
      }
    });
    assert.equal(expSync.status, 200);

    const link1 = await client.post('/api/routebooks/rb-shared-v9/friend-link', {
      profileId,
      expectedVersion: saveRb.data.routebook.version
    });
    assert.equal(link1.status, 200);
    const key1 = new URL(link1.data.friendShareUrl, 'http://localhost').searchParams.get('k');
    assert.ok(key1);

    const compPost = await fetch(`${server.baseUrl}/api/share/rb-shared-v9/companion?k=${key1}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        companionId: 'comp_xiaolin_01',
        nickname: '小林',
        votes: { 'st-1': 'want' },
        visitedStopIds: ['st-1'],
        expenses: [{ id: 'ce-1', title: '盐水鸭晚餐', amount: 120, paidBy: '小林' }]
      })
    });
    assert.equal(compPost.status, 200);
    const compJson = await compPost.json();
    assert.equal(compJson.companions.length, 1);
    assert.equal(compJson.companions[0].expenses[0].amount, 120);
    assert.deepEqual(compJson.companions[0].visitedStopIds, ['st-1']);

    // Verify owner reading routebook sees merged expenses & companions
    const ownerRead = await client.request('/api/routebooks/rb-shared-v9');
    assert.equal(ownerRead.status, 200);
    const mergedState = readExpenseState('rb-shared-v9', ['小林'], null, ownerRead.data.routebook.expenseLedger, ownerRead.data.routebook.companions);
    const split = calculateExpenseSplit({ stops: [], latestByStop: new Map(), ...mergedState });
    assert.equal(split.totalYuan, '160'); // 40 (owner) + 120 (companion)
    assert.equal(split.transfers.length, 1);
    assert.equal(split.transfers[0].from, '我');
    assert.equal(split.transfers[0].to, '小林');
    assert.equal(split.transfers[0].amountYuan, '40');

    // 4) Revoke friend link and re-open a new friend link -> old companion votes & expenses are isolated!
    const revoked = await client.request('/api/routebooks/rb-shared-v9/friend-link', {
      method: 'DELETE',
      body: { profileId, expectedVersion: link1.data.routebook.version }
    });
    assert.equal(revoked.status, 200);
    const link2 = await client.post('/api/routebooks/rb-shared-v9/friend-link', {
      profileId,
      expectedVersion: revoked.data.routebook.version
    });
    const key2 = new URL(link2.data.friendShareUrl, 'http://localhost').searchParams.get('k');
    assert.notEqual(key2, key1);

    const share2 = await fetch(`${server.baseUrl}/api/share/rb-shared-v9?k=${key2}`);
    const share2Json = await share2.json();
    assert.equal(share2Json.routebook.companions.length, 0, 'new link generation must not leak previous link companions');

    // 5) Public dining endpoint returns verified catalog dining without fabricated prices
    const diningRes = await fetch(`${server.baseUrl}/api/pois/dining?city=${encodeURIComponent('南京')}`);
    assert.equal(diningRes.status, 200);
    const diningJson = await diningRes.json();
    assert.ok(diningJson.pois.length >= 2);
    for (const p of diningJson.pois) {
      assert.ok(Number.isFinite(p.lat) && Number.isFinite(p.lng));
      assert.doesNotMatch(String(p.note || ''), /人均约\s*\d+\s*元/);
    }
  } finally {
    await server.stop();
  }
});

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { formatTransitWindowSummary, transitHubsForCity } from '../../src/components/Builder/builderModel.js';
import { analyzeTransitWindow, summarizeCostByCategory } from '../../src/lib/preTripAdvisor.js';
import { buildNearbyDining, filterNearbyRecommendations } from '../../src/lib/nearbyRecommendations.js';
import { appendWishlistItemToRoutebook } from '../../src/lib/wishlist.js';
import { summarizeCompanionResponses } from '../../src/lib/companionFeedback.js';
import { addExpenseTraveler, addExtraExpenseItem, calculateExpenseSplit, formatExpenseSplitSummary, readExpenseState } from '../../src/lib/expenseSplit.js';
import { buildPrintableItineraryHtml } from '../../src/lib/printItinerary.js';
import { buildUserPrompt, sanitizePayload } from '../../server/ai/generate.mjs';
import { startServer } from '../helpers/server.mjs';
import { authEnv, createClient } from '../helpers/accounts.mjs';

function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k)
  };
}

test('transit window presets, prompt scheduleRules, and pre-trip conflict checks work across formal cities', () => {
  assert.ok(transitHubsForCity('杭州').includes('杭州东站'));
  assert.ok(transitHubsForCity('南京市').includes('南京南站'));
  assert.equal(
    formatTransitWindowSummary({ arrivalTime: '10:30', arrivalHub: '杭州东站', departureTime: '17:30', departureHub: '杭州东站' }),
    '首日 10:30到杭州东站 · 末日 17:30从杭州东站走'
  );

  const sanitized = sanitizePayload({
    city: '杭州',
    guide: '柳浪闻莺、法喜寺、龙井茶园',
    constraints: {
      duration: '2 天 1 晚',
      arrivalTime: '10:30',
      arrivalHub: '杭州东站',
      departureTime: '17:30',
      departureHub: '杭州东站',
      mealPlan: '留出正餐时段'
    }
  });
  const { prompt } = buildUserPrompt(sanitized);
  assert.match(prompt, /首日到达约束.*10:30.*杭州东站/);
  assert.match(prompt, /末日返程约束.*17:30.*杭州东站/);
  assert.match(prompt, /11:30–13:30.*17:30–19:30/);

  const stops = [
    { id: 1, day: 'Day 1', time: '10:40', stay: '60 分钟', name: '柳浪闻莺', cost: '免费' },
    {
      id: 2,
      day: 'Day 2',
      time: '16:15',
      stay: '90 分钟',
      name: '法喜寺',
      cost: '10 元',
      costInfo: { amount: 10, min: 10, max: 10, unit: 'ticket', known: true, text: '10 元' }
    },
    {
      id: 3,
      day: 'Day 2',
      time: '12:00',
      stay: '60 分钟',
      name: '知味观',
      cost: '50 元',
      costInfo: { amount: 50, min: 50, max: 50, unit: 'meal', known: true, text: '50 元' }
    }
  ];
  const windowInfo = analyzeTransitWindow(stops, ['Day 1', 'Day 2'], sanitized.constraints);
  assert.equal(windowInfo.hasWindow, true);
  assert.equal(windowInfo.leaveByClock, '16:15');
  assert.match(windowInfo.arrivalConflict, /紧贴 10:30 到站时间/);
  assert.match(windowInfo.departureConflict, /距 17:30 返程较紧/);

  const breakdown = summarizeCostByCategory(stops);
  assert.match(breakdown.text, /门票 约 10 元 · 餐饮 约 50 元/);
});

test('buildNearbyDining surfaces verified local eateries within radius and filters under food', () => {
  const current = { id: 's1', name: '柳浪闻莺', city: '杭州', lat: 30.242, lng: 120.1617, geoConfidence: 95 };
  const catalogDining = [
    { poiId: 'poi-hz-zhiweiguan-hubin', name: '知味观·湖滨总店', city: '杭州', area: '湖滨', lat: 30.2528, lng: 120.1636, note: '价格以门店菜单为准' },
    { poiId: 'poi-hz-kuiyuanguan', name: '奎元馆·解放路总店', city: '杭州', area: '上城', lat: 30.2478, lng: 120.1695, note: '价格以门店菜单为准' }
  ];
  const dining = buildNearbyDining({ current, routebook: { city: '杭州', stops: [current] }, catalogDining });
  assert.ok(dining.length >= 2);
  assert.ok(dining.some((item) => item.name.includes('知味观') || item.name.includes('奎元馆')));
  assert.equal(filterNearbyRecommendations(dining, 'food').length, dining.length);
  assert.equal(filterNearbyRecommendations(dining, 'toilet').length, 0);
});

test('appendWishlistItemToRoutebook appends stop with canonical coordinates and schedule time', () => {
  const book = {
    id: 'route_test_1',
    city: '南京',
    title: '南京两日漫游',
    days: ['Day 1', 'Day 2'],
    stops: [{ id: 'a1', day: 'Day 1', time: '09:30', stay: '120 分钟', name: '南京博物院', lat: 32.0405, lng: 118.8247 }]
  };
  const res = appendWishlistItemToRoutebook(book, { city: '南京', place: '鸡鸣寺', note: '看樱花' }, 'Day 1');
  assert.ok(res);
  assert.equal(res.alreadyExists, false);
  assert.equal(res.exactCoords, true);
  assert.equal(res.dayStopCount, 2);
  assert.equal(res.addedStop.time, '12:00');
  assert.equal(res.routebook.stops.length, 2);

  const dup = appendWishlistItemToRoutebook(res.routebook, { city: '南京', place: '鸡鸣寺' }, 'Day 1');
  assert.equal(dup.alreadyExists, true);
});

test('calculateExpenseSplit computes exact cent-accurate balances and minimal transfers', () => {
  const storage = createMemoryStorage();
  addExpenseTraveler('rb-1', '小林', ['阿杰'], storage);
  addExtraExpenseItem('rb-1', { title: '东站打车', amount: '60 元', paidBy: '阿杰', splitWith: ['我', '小林', '阿杰'] }, ['阿杰'], storage);
  const state = readExpenseState('rb-1', ['阿杰'], storage);
  assert.deepEqual(state.travelers, ['我', '阿杰', '小林']);

  const stops = [
    { id: '1', name: '灵隐门票' },
    { id: '2', name: '龙井午饭' }
  ];
  const latestByStop = new Map([
    ['1', { status: 'visited', cost: '90 元', paidBy: '我', splitWith: ['我', '阿杰', '小林'] }],
    ['2', { status: 'visited', cost: '150 元', paidBy: '我', splitWith: ['我', '阿杰', '小林'] }]
  ]);
  const split = calculateExpenseSplit({
    stops,
    latestByStop,
    travelers: state.travelers,
    extraExpenses: state.extraExpenses
  });
  assert.equal(split.totalYuan, '300');
  assert.equal(split.perPersonYuan, '100');
  // 我 paid 240 (net +140), 阿杰 paid 60 (net -40), 小林 paid 0 (net -100)
  assert.equal(split.transfers.length, 2);
  assert.deepEqual(
    split.transfers.map((t) => `${t.from}->${t.to}:${t.amountYuan}`),
    ['小林->我:100', '阿杰->我:40']
  );
  const text = formatExpenseSplitSummary('杭州', '西湖漫游', split);
  assert.match(text, /小林 转给 我：100 元/);
  assert.equal(/！|您|核验|校验/.test(text), false);
});

test('buildPrintableItineraryHtml generates A4 sheet with per-stop SVG QR codes', () => {
  const html = buildPrintableItineraryHtml({
    city: '苏州',
    title: '园林水巷两日',
    days: ['Day 1'],
    stops: [
      { id: 1, day: 'Day 1', time: '09:00', name: '拙政园', area: '姑苏区', stay: '120 分钟', cost: '80 元', lat: 31.3243, lng: 120.6292, geoConfidence: 92 }
    ]
  });
  assert.match(html, /@page \{ size: A4 portrait/);
  assert.match(html, /拙政园/);
  assert.match(html, /<svg[^>]*aria-label="高德导航二维码"/);
});

test('POST /api/share/:id/companion syncs friend identity & votes without login and surfaces on owner routebook without mutating routebooks.jsonl version', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'companion-sync-test-'));
  const server = await startServer({ dataDir, env: authEnv('login', { ENRICH_ENABLED: 'false' }) });
  try {
    const owner = createClient(server.baseUrl);
    const reg = await owner.register('13800008811', 'CompPass123456');
    assert.equal(reg.status, 200);
    const profileId = reg.data.account.profileId;

    const createRes = await fetch(`${server.baseUrl}/api/routebooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: owner.cookie, origin: server.baseUrl },
      body: JSON.stringify({
        id: 'comp-rb-1',
        publicId: 'comp-rb-1',
        profileId,
        city: '杭州',
        title: '同行投票测试路书',
        days: ['Day 1'],
        stops: [
          {
            id: 's1',
            day: 'Day 1',
            time: '09:30',
            name: '柳浪闻莺',
            area: '西湖',
            stay: '60 分钟',
            cost: '免费',
            lat: 30.242,
            lng: 120.1617,
            geoConfidence: 90
          },
          {
            id: 's2',
            day: 'Day 1',
            time: '14:00',
            name: '南宋御街',
            area: '上城',
            stay: '60 分钟',
            cost: '免费',
            lat: 30.2432,
            lng: 120.1696,
            geoConfidence: 90
          }
        ]
      })
    });
    const created = await createRes.json();
    assert.equal(createRes.status, 200);

    const linkRes = await fetch(`${server.baseUrl}/api/routebooks/comp-rb-1/friend-link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: owner.cookie, origin: server.baseUrl },
      body: JSON.stringify({ profileId, expectedVersion: created.routebook.version })
    });
    const linkData = await linkRes.json();
    assert.equal(linkRes.status, 200);
    const friendKey = new URL(linkData.friendShareUrl, server.baseUrl).searchParams.get('k');
    assert.match(friendKey, /^[a-f0-9]{32}$/);
    const versionAfterLink = linkData.routebook.version;

    // Wrong key rejected
    const badRes = await fetch(`${server.baseUrl}/api/share/comp-rb-1/companion?k=${'0'.repeat(32)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: server.baseUrl },
      body: JSON.stringify({ companionId: 'comp_friend1', nickname: '小林', votes: { s2: 'skip' } })
    });
    assert.equal(badRes.status, 404);

    // Unauthenticated friend with valid ?k= submits nickname + vote + claim
    const voteRes = await fetch(`${server.baseUrl}/api/share/comp-rb-1/companion?k=${friendKey}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: server.baseUrl },
      body: JSON.stringify({
        companionId: 'comp_friend1',
        nickname: '小林',
        votes: { s1: 'want', s2: 'skip' },
        claims: ['s1:reservation']
      })
    });
    const voteData = await voteRes.json();
    assert.equal(voteRes.status, 200);
    assert.equal(voteData.companions.length, 1);
    assert.equal(voteData.companions[0].nickname, '小林');

    // Owner GET /api/routebooks/comp-rb-1 sees companions and version did NOT bump
    const ownerGet = await (
      await fetch(`${server.baseUrl}/api/routebooks/comp-rb-1`, {
        headers: { cookie: owner.cookie }
      })
    ).json();
    assert.equal(ownerGet.routebook.version, versionAfterLink);
    assert.equal(ownerGet.routebook.companions.length, 1);
    const summary = summarizeCompanionResponses(ownerGet.routebook, ownerGet.routebook.companions);
    assert.deepEqual(summary.memberNames, ['小林']);
    assert.equal(summary.skipSuggestions.length, 1);
    assert.equal(summary.skipSuggestions[0].stop.name, '南宋御街');
  } finally {
    await server.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

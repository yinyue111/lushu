import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPlaceCandidates } from '../../src/lib/placeCandidates.js';
import { knownPoiCoordinates } from '../../src/lib/coordinates.js';
import { createPrivateRoutebookDraft } from '../../src/lib/privateDraft.js';
import { isAiGeneratedRoutebook } from '../../src/lib/aigc.js';
import { buildStopsForMode, navigationForStop } from '../../src/components/Trip/tripModel.js';
import { curatedRoutes, curatedRouteToRoutebook, getCityPhotos } from '../../src/lib/content.js';
import { guardRoutebookFacts } from '../../server/ai/factGuard.mjs';
import { formatStayText } from '../../src/lib/routeMeta.js';
import { geocodePoiWithAmap } from '../../server/geo/amap.mjs';
import { fetchTileWithRetry } from '../../server/http/map-tiles.mjs';
import { MAP_TILE_PROVIDER_CATALOG } from '../../server/http/map-providers.mjs';
import { startGenerationJob } from '../../server/ai/generationJobs.mjs';
import { sanitizePayload } from '../../server/ai/generate.mjs';
import { buildProposalDiff, parseAdjustIntent } from '../../src/lib/adjustIntents.js';
import { confirmItemsForStop } from '../../src/lib/confirmChecklist.js';
import { getStopTrustBadge } from '../../src/lib/trust.js';
import { stopCategory } from '../../src/components/visual/theme.js';

test('extractPlaceCandidates filters Nanjing dishes, deduplicates 夫子庙, and recognizes 中山陵', () => {
  const known = Object.entries(knownPoiCoordinates)
    .filter(([, meta]) => meta.city === '南京')
    .map(([name]) => name);
  const candidates = extractPlaceCandidates('南京两天一夜，想去中山陵、南京博物院、老门东、夫子庙秦淮河，吃鸭血粉丝汤和盐水鸭，带父母不要太累', {
    knownPlaces: known
  });
  const names = candidates.map((c) => c.name);
  assert.ok(names.includes('中山陵'), `expected 中山陵 in ${JSON.stringify(names)}`);
  assert.ok(names.includes('南京博物院'));
  assert.ok(names.includes('老门东'));
  assert.ok(!names.includes('鸭血粉丝汤'), `dish should be filtered: ${JSON.stringify(names)}`);
  assert.ok(!names.includes('盐水鸭'), `dish should be filtered: ${JSON.stringify(names)}`);
  const zsl = candidates.find((c) => c.name === '中山陵');
  assert.equal(zsl?.rule, 'dictionary');
  assert.ok(!names.includes('夫子庙秦淮河'), `duplicate prefix combo should be dropped: ${JSON.stringify(names)}`);
});

test('createPrivateRoutebookDraft does not mark editorial curated clone as AI generated', () => {
  const curated = curatedRouteToRoutebook(curatedRoutes[0]);
  const draft = createPrivateRoutebookDraft(curated, { id: 'p_test', creatorName: '测试' });
  assert.equal(draft.version, 0);
  assert.equal(isAiGeneratedRoutebook(draft), false);

  const aiSource = { ...curated, provider: { model: 'deepseek-v4.1-flash', generatedAt: '2026-11-26T00:00:00Z' } };
  const aiDraft = createPrivateRoutebookDraft(aiSource, { id: 'p_test', creatorName: '测试' });
  assert.equal(isAiGeneratedRoutebook(aiDraft), true);
});

test('buildStopsForMode recalculates forward stop times after rainy reorder', () => {
  const hz = curatedRouteToRoutebook(curatedRoutes[0]);
  const result = buildStopsForMode('雨天', hz.stops, hz, null, new Set());
  const day1 = result.stops.filter((s) => s.day === 'Day 1');
  assert.equal(day1.length, 3);
  const toMin = (t) => {
    const [h, m] = String(t).split(':').map(Number);
    return h * 60 + m;
  };
  assert.ok(toMin(day1[0].time) < toMin(day1[1].time), `expected monotonic times, got ${day1.map((s) => s.time).join(' -> ')}`);
  assert.ok(toMin(day1[1].time) < toMin(day1[2].time), `expected monotonic times, got ${day1.map((s) => s.time).join(' -> ')}`);
});

test('navigationForStop uses transit/walk rather than car for 公交地铁 + 步行 routes', () => {
  const hz = curatedRouteToRoutebook(curatedRoutes[0]);
  // Stop 0 (柳浪闻莺) with no previous stop on a 公交地铁 + 步行 route -> bus
  const nav0 = navigationForStop(hz.stops, 0, hz, new Map());
  assert.notEqual(nav0.mode, 'car');
  assert.equal(nav0.label, '公交地铁导航');
  // Stop 1 (南宋御街, 0.8km from 柳浪闻莺) -> walk
  const nav1 = navigationForStop(hz.stops, 1, hz, new Map());
  assert.equal(nav1.mode, 'walk');
  assert.equal(nav1.label, '步行导航');
  // Stop 2 (北山街日落线, 2.8km from 南宋御街) on 公交地铁 + 步行 -> bus
  const nav2 = navigationForStop(hz.stops, 2, hz, new Map());
  assert.equal(nav2.mode, 'bus');
  assert.equal(nav2.label, '公交地铁导航');
});

test('Nanjing has at least 2 distinct inspiration photos', () => {
  const photos = getCityPhotos('南京');
  assert.ok(photos.length >= 2);
  assert.notEqual(photos[0].image, photos[1].image);
});

test('guardRoutebookFacts preserves user-selected ISO travel date when written in Chinese prose', () => {
  const rb = {
    title: '苏州亲子一日路书',
    summary: '11月28日（周六），上午步行串联拙政园和苏州博物馆。',
    stops: [{ name: '拙政园', cost: '80 元', verify: '11月28日入园请提前预约', risk: '' }],
    aiNotes: []
  };
  const { routebook } = guardRoutebookFacts(rb, {
    city: '苏州',
    guide: '想去拙政园门票80元',
    constraints: { date: '2026-11-28' }
  });
  assert.ok(routebook.summary.includes('11月28日'), `date should not be redacted: ${routebook.summary}`);
  assert.ok(!routebook.summary.includes('日期待确认'), `unexpected 日期待确认 in ${routebook.summary}`);
  assert.ok(routebook.stops[0].verify.includes('11月28日'));
});

test('formatStayText strips truncated trailing clauses from legacy stop.stay values', () => {
  assert.equal(formatStayText('约 2.5 小时，沿湖步行，可随时在'), '约 2.5 小时');
  assert.equal(formatStayText('约 2–2.5 小时，步行街区可边走'), '约 2–2.5 小时');
  assert.equal(formatStayText('90分钟'), '90 分钟');
});

test('extractPlaceCandidates skips activity clauses like 坐船看夜景', () => {
  const known = Object.entries(knownPoiCoordinates)
    .filter(([, meta]) => meta.city === '苏州')
    .map(([name]) => name);
  const candidates = extractPlaceCandidates('苏州一日游：上午拙政园、苏州博物馆，中午平江路吃面，下午山塘街，晚上想坐船看夜景', {
    knownPlaces: known
  });
  const names = candidates.map((c) => c.name);
  assert.ok(!names.includes('坐船看夜景'), `activity should not be extracted as place: ${JSON.stringify(names)}`);
  assert.ok(names.includes('拙政园'));
  assert.ok(names.includes('苏州博物馆'));
});

test('geocodePoiWithAmap snaps bare 西湖 to shoreline entrance instead of open water', async () => {
  const res = await geocodePoiWithAmap('杭州', '西湖');
  assert.ok(res);
  assert.equal(res.coordinateSource, 'known-poi');
  // Must be at shoreline (~120.1615), not open water (~120.1395)
  assert.ok(res.lng > 120.155, `expected shoreline lng > 120.155, got ${res.lng}`);
});

test('map tile proxy retries MAP_TILE_UPSTREAM_TIMEOUT once and rotates AMap subdomain', async () => {
  const hosts = [];
  const tile = await fetchTileWithRetry(
    async (upstream, req) => {
      hosts.push(upstream.hostname(req));
      if (hosts.length === 1) {
        throw Object.assign(new Error('地图上游连接超时'), { statusCode: 504, code: 'MAP_TILE_UPSTREAM_TIMEOUT' });
      }
      return { body: Buffer.from('png'), source: upstream.id };
    },
    MAP_TILE_PROVIDER_CATALOG.amap,
    { z: 14, x: 13599, y: 6660 },
    new AbortController().signal
  );
  assert.equal(hosts.length, 2);
  assert.notEqual(hosts[0], hosts[1], `expected subdomain rotation, got ${JSON.stringify(hosts)}`);
  assert.equal(tile.source, 'amap');
});

test('startGenerationJob grants post-model grace window so finished LLM jobs are not killed during routing', async () => {
  const { job } = startGenerationJob({
    dedupKey: `grace_${Date.now()}`,
    clientKey: 'test_grace_client',
    profileId: 'p_grace',
    timeoutMs: 80,
    mode: 'fast',
    run: async (signal, onStage) => {
      onStage({ stage: 'model', state: 'started' });
      await new Promise((r) => setTimeout(r, 20));
      onStage({ stage: 'model', state: 'completed', detail: '返回 4 个站点' });
      onStage({ stage: 'route', state: 'started' });
      await new Promise((r) => setTimeout(r, 110));
      assert.equal(signal.aborted, false, 'job should survive past 80ms once model stage is completed');
      onStage({ stage: 'route', state: 'completed' });
      return { id: 'rb_ok', stops: [] };
    }
  });
  await job.promise;
  assert.equal(job.status, 'succeeded');
});

test('sanitizePayload mirrors single arrivalHub to departureHub and extractPlaceCandidates skips station hubs', () => {
  const clean = sanitizePayload({
    city: '南京',
    guide: '南京两天慢游：去南京博物院、老门东，最后从南京南站返程',
    constraints: { arrivalTime: '09:30', arrivalHub: '南京南站', departureTime: '20:30', departureHub: '' }
  });
  assert.equal(clean.constraints.departureHub, '南京南站');

  const candidates = extractPlaceCandidates('南京两天慢游：去南京博物院、老门东，最后从南京南站返程', {
    knownPlaces: ['南京博物院', '老门东', '南京南站']
  });
  const names = candidates.map((c) => c.name);
  assert.ok(!names.includes('南京南站'), `transit hub should not be extracted as scenic candidate: ${JSON.stringify(names)}`);
});

test('parseAdjustIntent treats 晚点出发 as free L1 shift_day_start and buildProposalDiff ignores dash/range noise', () => {
  const intent = parseAdjustIntent('晚点出发', { days: ['Day 1', 'Day 2'], stopNames: ['南京博物院'], activeDay: 'Day 1' });
  assert.equal(intent?.kind, 'shift_day_start');
  assert.equal(intent?.level, 'L1');

  const diff = buildProposalDiff(
    [
      { id: '1', day: 'Day 2', name: '先锋书店五台山总店', time: '10:15-11:20' },
      { id: '2', day: 'Day 2', name: '老门东', time: '12:00-13:20' }
    ],
    {
      scope: { type: 'day', day: 'Day 2' },
      stops: [
        { id: '1', day: 'Day 2', name: '先锋书店五台山总店', time: '10:15–11:20' },
        { id: '2', day: 'Day 2', name: '老门东', time: '12:00' }
      ]
    }
  );
  assert.equal(diff.movedCount, 0, `expected 0 false-positive retimed stops, got ${diff.movedCount}`);
});

test('confirmItemsForStop avoids double city prefix, getStopTrustBadge marks geocoded stops, and stopCategory picks proper scenes', () => {
  const items = confirmItemsForStop({ id: 1, name: '南京博物院', verify: '需提前预约' }, { city: '南京' });
  const resItem = items.find((i) => i.kind === 'reservation');
  assert.ok(resItem?.action?.url && !decodeURIComponent(resItem.action.url).includes('南京南京博物院'));

  const badge = getStopTrustBadge({ lat: 32.06, lng: 118.85, geoConfidence: 90, coordinateSource: 'amap-poi', navigationDisabled: false }, 'prediction');
  assert.equal(badge.value, '定位已核对');

  assert.equal(stopCategory({ name: '先锋书店五台山总店' }).id, 'book-cafe');
  assert.equal(stopCategory({ name: '夫子庙秦淮风光带' }).id, 'historic-quarter');
  assert.ok(stopCategory({ name: '老门东' }).scene, '老门东 should have a scene image');
});

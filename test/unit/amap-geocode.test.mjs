import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearGeocodeCache, geocodePoiWithAmap } from '../../server/geo/amap.mjs';
import {
  GEOCODE_PRECISION,
  arrivalRadiusExtraMeters,
  chooseGeocodeCandidate,
  classifyNameMatch,
  precisionFromAmapLevel
} from '../../server/geo/geocodeChooser.mjs';
import { buildArrivalEvidence } from '../../server/trust/arrival.mjs';

// Mock AMap responses only; no request leaves the process.
function mockFetch(routes) {
  const calls = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    calls.push({ path: parsed.pathname, params: Object.fromEntries(parsed.searchParams) });
    const body = routes[parsed.pathname];
    if (!body) return { ok: false, json: async () => ({}) };
    return { ok: true, json: async () => body };
  };
  return { fetchImpl, calls };
}

const poi = (id, name, location, extra = {}) => ({ id, name, location, address: '测试地址', typecode: '110200', ...extra });

test('name matching is rule-based: exact, alias/suffix variant, bounded containment', () => {
  assert.equal(classifyNameMatch('灵隐寺', '灵隐寺'), 'exact');
  assert.equal(classifyNameMatch('西湖风景名胜区', '西湖'), 'alias');
  assert.equal(classifyNameMatch('河坊街', '清河坊街'), 'contains');
  assert.equal(classifyNameMatch('西湖', '西湖区第三人民医院'), null);
  assert.equal(classifyNameMatch('灵隐寺', '飞来峰'), null);
  assert.equal(classifyNameMatch('老街', '旧街', ['旧街']), 'alias');
});

test('chooser prefers stronger match, then similarity, then provider rank, deterministically', () => {
  const candidates = [
    { id: 'B', name: '清河坊街(南口)', rank: 0 },
    { id: 'A', name: '河坊街', rank: 1 },
    { id: 'C', name: '河坊街', rank: 2 }
  ];
  const choice = chooseGeocodeCandidate({ name: '河坊街' }, candidates);
  assert.equal(choice.chosen.id, 'A');
  assert.equal(choice.matchType, 'exact');
  assert.equal(choice.precision, GEOCODE_PRECISION.POI_EXACT);
  // Same result regardless of array order.
  assert.equal(chooseGeocodeCandidate({ name: '河坊街' }, [...candidates].reverse()).chosen.id, 'A');
  const none = chooseGeocodeCandidate({ name: '灵隐寺' }, [{ id: 'X', name: '杭州东站' }]);
  assert.equal(none.chosen, null);
  assert.equal(none.reason, 'no-name-match');
  assert.equal(chooseGeocodeCandidate({ name: '灵隐寺' }, []).reason, 'no-candidates');
});

test('POI search picks the matching candidate, records precision and keeps navigation on', async () => {
  clearGeocodeCache();
  const { fetchImpl, calls } = mockFetch({
    '/v3/place/text': {
      status: '1',
      pois: [poi('P1', '杭州东站', '120.212,30.290'), poi('P2', '灵隐寺', '120.101,30.241')]
    }
  });
  /** @type {any} */
  let observed = null;
  const result = await geocodePoiWithAmap('杭州', '灵隐寺', undefined, {
    fetchImpl,
    apiKey: 'test-key',
    baseUrl: 'http://amap.mock',
    onCandidates: (info) => {
      observed = info;
      throw new Error('observer errors are ignored');
    }
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/v3/place/text');
  assert.equal(calls[0].params.citylimit, 'true');
  assert.equal(result.coordinateSource, 'amap-poi');
  assert.equal(result.coordinatePrecision, 'poi-exact');
  assert.equal(result.navigationDisabled, false);
  assert.equal(result.geocodeChoice.chosenPoiId, 'P2');
  assert.equal(result.geocodeChoice.candidateCount, 2);
  assert.equal(observed.candidates.length, 2);
  // GCJ02 → WGS84 shifts the point by a few hundred metres at most.
  assert.ok(Math.abs(result.lat - 30.241) < 0.01 && Math.abs(result.lng - 120.101) < 0.01);
});

test('no acceptable POI falls back to address geocoding with level-derived precision', async () => {
  clearGeocodeCache();
  const { fetchImpl, calls } = mockFetch({
    '/v3/place/text': { status: '1', pois: [poi('P9', '无关地点', '120.15,30.25')] },
    '/v3/geocode/geo': { status: '1', geocodes: [{ location: '120.16,30.26', level: '道路' }] }
  });
  const result = await geocodePoiWithAmap('杭州', '某条小路', undefined, { fetchImpl, apiKey: 'k', baseUrl: 'http://amap.mock' });
  assert.deepEqual(
    calls.map((call) => call.path),
    ['/v3/place/text', '/v3/geocode/geo']
  );
  assert.equal(result.coordinateSource, 'amap-geocode');
  assert.equal(result.coordinatePrecision, 'road');
  assert.equal(result.geocodeChoice.rejectedReason, 'no-name-match');

  clearGeocodeCache();
  const coarse = mockFetch({
    '/v3/place/text': { status: '0', info: 'INVALID_USER_KEY' },
    '/v3/geocode/geo': { status: '1', geocodes: [{ location: '120.16,30.26', level: '区县' }] }
  });
  const approximate = await geocodePoiWithAmap('杭州', '某区', undefined, { fetchImpl: coarse.fetchImpl, apiKey: 'k', baseUrl: 'http://amap.mock' });
  assert.equal(approximate.coordinatePrecision, 'approximate');
  assert.equal(approximate.navigationDisabled, true);
});

test('out-of-city candidates are dropped and an empty result returns null', async () => {
  clearGeocodeCache();
  const { fetchImpl } = mockFetch({
    '/v3/place/text': { status: '1', pois: [poi('BJ', '灵隐寺', '116.40,39.90')] },
    '/v3/geocode/geo': { status: '1', geocodes: [] }
  });
  assert.equal(await geocodePoiWithAmap('杭州', '灵隐寺', undefined, { fetchImpl, apiKey: 'k', baseUrl: 'http://amap.mock' }), null);
});

test('place-name typecodes are recorded as address precision, not exact POI', async () => {
  clearGeocodeCache();
  const { fetchImpl } = mockFetch({
    '/v3/place/text': { status: '1', pois: [poi('A1', '龙井村', '120.12,30.22', { typecode: '190108' })] }
  });
  const result = await geocodePoiWithAmap('杭州', '龙井村', undefined, { fetchImpl, apiKey: 'k', baseUrl: 'http://amap.mock' });
  assert.equal(result.coordinatePrecision, 'address');
});

test('arrival radius scales with coordinate precision, capped and never for coarse coordinates', () => {
  assert.equal(precisionFromAmapLevel('兴趣点'), 'address');
  assert.equal(arrivalRadiusExtraMeters('poi-exact'), 0);
  assert.equal(arrivalRadiusExtraMeters('address'), 100);
  assert.equal(arrivalRadiusExtraMeters('anything-else'), 0);
  const base = { id: 's1', name: '测试站', lat: 30.25, lng: 120.15, geoConfidence: 90, coordinateSource: 'amap-poi' };
  const gps = { gps: { lat: 30.2528, lng: 120.15, accuracy: 10, coordinateSystem: 'wgs84' } }; // ~311 m away
  const exact = buildArrivalEvidence(gps, { ...base, coordinatePrecision: 'poi-exact' });
  const road = /** @type {any} */ (buildArrivalEvidence(gps, { ...base, coordinatePrecision: 'road' }));
  assert.equal(exact.thresholdMeters, 250);
  assert.equal(exact.valid, false);
  assert.equal(road.thresholdMeters, 500);
  assert.equal(road.valid, true);
  assert.equal(road.precisionRadiusExtraMeters, 250);
  const coarse = buildArrivalEvidence(gps, { ...base, coordinatePrecision: 'road', geoConfidence: 55, navigationDisabled: true });
  assert.equal(coarse.valid, false);
  assert.equal(coarse.thresholdMeters, null);
});

test('containment never picks a hotel, parking lot or branch named after the sight', () => {
  // Shapes seen in a real AMap /v3/place/text answer for 杭州「西湖音乐喷泉」: the sight itself
  // was not in the top 10, only businesses named after it.
  const candidates = [
    { id: 'h1', name: '西湖音乐喷泉公寓酒店', typecode: '100100', rank: 1 },
    { id: 'p1', name: '全季酒店杭州西湖音乐喷泉店停车场', typecode: '150904', rank: 6 },
    { id: 'r1', name: '餐厅(西湖音乐喷泉店)', typecode: '050100', rank: 4 }
  ];
  const choice = chooseGeocodeCandidate({ name: '西湖音乐喷泉' }, candidates);
  assert.equal(choice.chosen, null, 'falls through to address geocoding instead');
  assert.equal(choice.reason, 'no-name-match');
  // The parking lot is already too long for containment; the hotel and the branch are refused here.
  assert.equal(choice.facilityRejectedCount, 2);
  // A sub-feature of the sight is still a containment match.
  const stele = chooseGeocodeCandidate({ name: '断桥残雪' }, [{ id: 's1', name: '断桥残雪碑亭', typecode: '110200', rank: 0 }]);
  assert.equal(stele.chosen.id, 's1');
  assert.equal(stele.precision, 'poi-name-match');
  // Asking for the hotel itself still works, and exact names are never filtered.
  assert.equal(chooseGeocodeCandidate({ name: '音乐喷泉公寓酒店' }, candidates).chosen.id, 'h1');
  assert.equal(chooseGeocodeCandidate({ name: '西湖音乐喷泉公寓酒店' }, candidates).matchType, 'exact');
});

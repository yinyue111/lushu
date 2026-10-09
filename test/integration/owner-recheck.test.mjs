import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { fetchJson, jsonHeaders, startServer } from '../helpers/server.mjs';

// Minimal AMap stand-in: POI search by keyword and walking directions.
async function startMockAmap() {
  const calls = { place: [], walking: 0 };
  const places = {
    测试咖啡馆: '120.160,30.260',
    测试书店: '120.165,30.262',
    测试茶室: '120.170,30.265',
    新换的面馆: '120.172,30.266'
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock');
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/v3/place/text') {
      const keyword = url.searchParams.get('keywords') ?? '';
      calls.place.push(keyword);
      const location = places[keyword];
      return res.end(
        JSON.stringify({ status: '1', pois: location ? [{ id: `P-${keyword}`, name: keyword, location, address: '测试地址', typecode: '050500' }] : [] })
      );
    }
    if (url.pathname === '/v3/geocode/geo') return res.end(JSON.stringify({ status: '1', geocodes: [] }));
    if (url.pathname === '/v3/direction/walking') {
      calls.walking += 1;
      const [from, to] = [url.searchParams.get('origin'), url.searchParams.get('destination')];
      return res.end(JSON.stringify({ status: '1', route: { paths: [{ distance: '600', duration: '480', steps: [{ polyline: `${from};${to}` }] }] } }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return { baseUrl: `http://127.0.0.1:${port}`, calls, stop: () => new Promise((resolve) => server.close(() => resolve(undefined))) };
}

test('owner re-check re-geocodes replaced stops and re-verifies only the legs they touch (rate-limited)', async (t) => {
  const amap = await startMockAmap();
  t.after(amap.stop);
  const server = await startServer({
    env: { AMAP_GEOCODE_KEY: 'mock-amap-key', AMAP_API_BASE_URL: amap.baseUrl, RATE_LIMIT_RECHECK_MAX: '3', AMAP_QPS: '50' }
  });
  t.after(server.stop);
  /** @param {string} path @param {any} body */
  const post = (path, body) => fetchJson(`${server.baseUrl}${path}`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(body) });
  const draft = await post('/api/routebooks', {
    city: '杭州',
    title: '重新核验回归',
    constraints: { transport: '步行' },
    stops: [
      { id: 'a', day: 'Day 1', name: '测试咖啡馆', lat: 30.2, lng: 120.1 },
      { id: 'b', day: 'Day 1', name: '测试书店', lat: 30.21, lng: 120.11 },
      { id: 'c', day: 'Day 1', name: '测试茶室', lat: 30.22, lng: 120.12 }
    ]
  });
  assert.equal(draft.status, 200, JSON.stringify(draft.data));
  const id = draft.data.routebook.publicId;
  const editToken = draft.data.routebook.editToken;
  assert.ok(draft.data.routebook.stops.every((/** @type {any} */ stop) => stop.coordinateSource === 'user-edit'));

  assert.equal((await post(`/api/routebooks/${id}/recheck`, { expectedVersion: 1 })).status, 403, 'owner only');
  const first = await post(`/api/routebooks/${id}/recheck`, { editToken, expectedVersion: 1 });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.deepEqual([...first.data.recheck.geocoded].sort(), ['测试书店', '测试咖啡馆', '测试茶室'].sort());
  assert.ok(first.data.routebook.stops.every((/** @type {any} */ stop) => stop.coordinateSource === 'amap-poi' && stop.navigationDisabled !== true));
  assert.equal(first.data.recheck.routing.verifiedLegs, 2);
  assert.equal(amap.calls.walking, 2);

  // Replace stop c: the user edit downgrades it; the re-check re-geocodes it and only
  // the touched leg (b -> c) is queried again.
  const replaced = first.data.routebook.stops.map((/** @type {any} */ stop) =>
    stop.id === 'c' ? { ...stop, name: '新换的面馆', lat: 30.23, lng: 120.13 } : stop
  );
  const saved = await post('/api/routebooks', { ...first.data.routebook, editToken, stops: replaced, expectedVersion: 2 });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.routebook.stops.find((/** @type {any} */ stop) => stop.id === 'c').coordinateSource, 'user-edit');
  const second = await post(`/api/routebooks/${id}/recheck`, { editToken, expectedVersion: 3, stopIds: ['c'] });
  assert.equal(second.status, 200, JSON.stringify(second.data));
  assert.deepEqual(second.data.recheck.geocoded, ['新换的面馆']);
  assert.equal(second.data.recheck.routing.verifiedLegs, 2);
  assert.equal(amap.calls.walking, 3, 'only the leg touching the replaced stop is re-verified');
  const versions = await fetchJson(`${server.baseUrl}/api/routebooks/${id}/versions`, { headers: { 'x-routebook-admin-token': 'unit-test-admin-token' } });
  assert.ok(versions.data.audits.some((/** @type {any} */ audit) => audit.event === 'owner-rechecked'));

  // RATE_LIMIT_RECHECK_MAX=3 and three calls were made (including the rejected one).
  const blocked = await post(`/api/routebooks/${id}/recheck`, { editToken, expectedVersion: 4 });
  assert.equal(blocked.status, 429, 'rate-limited per client');
});

test('owner re-check is for drafts only', async (t) => {
  const server = await startServer();
  t.after(server.stop);
  /** @param {string} path @param {any} body */
  const post = (path, body) => fetchJson(`${server.baseUrl}${path}`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(body) });
  const draft = await post('/api/routebooks', {
    city: '杭州',
    stops: [
      { id: 'a', day: 'Day 1', name: '测试咖啡馆', lat: 30.2, lng: 120.1 },
      { id: 'b', day: 'Day 1', name: '测试书店', lat: 30.21, lng: 120.11 }
    ]
  });
  const editToken = draft.data.routebook.editToken;
  const id = draft.data.routebook.publicId;
  const noKey = await post(`/api/routebooks/${id}/recheck`, { editToken, expectedVersion: 1 });
  assert.equal(noKey.status, 200, JSON.stringify(noKey.data));
  assert.equal(noKey.data.recheck.geocodingConfigured, false);
  assert.equal(noKey.data.recheck.unresolved.length, 2);
  await post(`/api/routebooks/${id}/publish`, { editToken, expectedVersion: 2 });
  const pending = await post(`/api/routebooks/${id}/recheck`, { editToken, expectedVersion: 3 });
  assert.equal(pending.status, 409);
  assert.equal(pending.data.code, 'ROUTEBOOK_RECHECK_DRAFT_ONLY');
});

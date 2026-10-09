import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRouteLegs, createAmapRoutingProvider, summarizeRouteExecution, routeExecutionValidationRows } from '../../server/routing/index.mjs';
import { normalizeStoredRouteLegs, signRouteLeg } from '../../server/routing/provenance.mjs';
import { requireVerifiedRoutingForPublicStatus } from '../../server/routebooks/mutations.mjs';
import { normalizeRoutebookForStorage } from '../../server/routebooks/normalize.mjs';
import { publicRoutebookView } from '../../server/routebooks/views.mjs';
import { submitRoutebookStatusWithRoutingGate } from '../../src/components/Ops/routebookPublication.js';
import { roadSummary } from '../../src/lib/routeRoads.js';

function stops() {
  return [
    { id: 's1', day: 'Day 1', name: '断桥残雪', lat: 30.2588, lng: 120.1525, coordinateSystem: 'WGS84', geoConfidence: 92, time: '10:00', stay: '60 分钟' },
    { id: 's2', day: 'Day 1', name: '平湖秋月', lat: 30.2525, lng: 120.1441, coordinateSystem: 'WGS84', geoConfidence: 92, time: '11:10', stay: '60 分钟' }
  ];
}

function verifiedLeg(sourceStops = stops()) {
  const leg = {
    fromStopId: 's1',
    toStopId: 's2',
    mode: 'walking',
    status: 'verified',
    provider: 'amap',
    distanceMeters: 2200,
    durationSeconds: 1800,
    queriedAt: '2026-10-09T00:00:00Z',
    geometry: sourceStops.map((stop) => [stop.lat, stop.lng])
  };
  return { ...leg, proof: signRouteLeg(leg, sourceStops[0], sourceStops[1]) };
}

test('missing provider and imprecise coordinates never become verified or call upstream', async () => {
  let calls = 0;
  const provider = createAmapRoutingProvider({
    apiKey: '',
    fetchImpl: async () => {
      calls += 1;
      throw new Error('not expected');
    }
  });
  const missing = await buildRouteLegs({ stops: stops(), provider });
  assert.equal(missing[0].status, 'unverified');
  assert.equal(missing[0].error.code, 'ROUTING_PROVIDER_NOT_CONFIGURED');
  assert.equal(missing[0].distanceMeters, null);
  const imprecise = await buildRouteLegs({
    stops: stops().map((stop) => ({ ...stop, navigationDisabled: true })),
    provider: {
      id: 'mock',
      route: async () => {
        calls += 1;
      }
    }
  });
  assert.equal(imprecise[0].error.code, 'ROUTING_COORDINATES_UNVERIFIED');
  assert.equal(calls, 0);
});

test('mock Amap payload becomes WGS84 road geometry with timestamp and mode', async () => {
  let target = new URL('https://example.test');
  const provider = createAmapRoutingProvider({
    apiKey: 'fake-test-key',
    fetchImpl: async (url) => {
      target = new URL(url);
      return new Response(
        JSON.stringify({
          status: '1',
          route: { paths: [{ distance: '1200', duration: '900', steps: [{ polyline: '120.157000,30.256000;120.150000,30.250000' }] }] }
        })
      );
    }
  });
  const [leg] = await buildRouteLegs({ stops: stops(), provider, now: () => new Date('2026-10-09T00:00:00Z') });
  assert.equal(target.pathname, '/v3/direction/walking');
  assert.equal(leg.status, 'verified');
  assert.equal(leg.distanceMeters, 1200);
  assert.equal(leg.durationSeconds, 900);
  assert.equal(leg.provider, 'amap');
  assert.equal(leg.queriedAt, '2026-10-09T00:00:00.000Z');
  assert.notEqual(leg.geometry[0][0], 30.256);
});

test('server signature binds road data and coordinates; forged/stale legs downgrade', () => {
  const sourceStops = stops();
  const signed = verifiedLeg(sourceStops);
  assert.equal(normalizeStoredRouteLegs([signed], sourceStops)[0].status, 'verified');
  for (const candidate of [
    { ...signed, proof: '' },
    { ...signed, durationSeconds: 1 },
    {
      ...signed,
      geometry: [
        [1, 1],
        [2, 2]
      ]
    }
  ]) {
    const leg = normalizeStoredRouteLegs([candidate], sourceStops)[0];
    assert.equal(leg.status, 'unverified');
    assert.equal(leg.distanceMeters, null);
    assert.deepEqual(leg.geometry, []);
  }
  const moved = sourceStops.map((stop, index) => (index ? { ...stop, lat: stop.lat + 0.001 } : stop));
  assert.equal(normalizeStoredRouteLegs([signed], moved)[0].status, 'unverified');
  assert.equal(normalizeStoredRouteLegs([signed], sourceStops, 'driving')[0].status, 'unverified');
  assert.deepEqual(normalizeStoredRouteLegs([signed], [sourceStops[1], sourceStops[0]]), []);
});

test('provider failure and incomplete geometry never retain road precision', async () => {
  for (const provider of [
    {
      id: 'fake',
      route: async () => {
        throw new Error('upstream private detail');
      }
    },
    { id: 'fake', route: async () => ({ status: 'verified', distanceMeters: 10, durationSeconds: 1, geometry: [] }) }
  ]) {
    const [leg] = await buildRouteLegs({ stops: stops(), provider });
    assert.equal(leg.status, 'unverified');
    assert.equal(leg.distanceMeters, null);
    assert.equal(leg.durationSeconds, null);
    assert.deepEqual(leg.geometry, []);
    assert.doesNotMatch(leg.error.message, /private detail/);
  }
});

test('Amap timeouts are explicit and caller cancellation aborts the complete operation', async () => {
  const provider = createAmapRoutingProvider({
    apiKey: 'fake',
    timeoutMs: 5,
    fetchImpl: async (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
      })
  });
  const [timedOut] = await buildRouteLegs({ stops: stops(), provider });
  assert.equal(timedOut.error.code, 'ROUTING_TIMEOUT');
  assert.equal(timedOut.status, 'unverified');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(buildRouteLegs({ stops: stops(), provider, signal: controller.signal }), { code: 'ROUTING_CANCELLED' });
});

test('routing concurrency is bounded and output retains adjacent stop order', async () => {
  let active = 0;
  let peak = 0;
  const sourceStops = Array.from({ length: 7 }, (_, index) => ({ ...stops()[0], id: String(index), lng: 120.1 + index / 1000 }));
  const legs = await buildRouteLegs({
    stops: sourceStops,
    concurrency: 2,
    provider: {
      id: 'fake',
      route: async ({ fromStop, toStop }) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return {
          status: 'verified',
          distanceMeters: 100,
          durationSeconds: 60,
          geometry: [
            [fromStop.lat, fromStop.lng],
            [toStop.lat, toStop.lng]
          ]
        };
      }
    }
  });
  assert.equal(peak, 2);
  assert.deepEqual(
    legs.map((leg) => leg.fromStopId),
    ['0', '1', '2', '3', '4', '5']
  );
});

test('publication blocks unverified routes; only explicit long-reason override passes', () => {
  const routebook = { stops: stops(), routeLegs: [] };
  assert.throws(() => requireVerifiedRoutingForPublicStatus(routebook), { code: 'ROUTEBOOK_ROUTING_UNVERIFIED', statusCode: 409 });
  assert.throws(() => requireVerifiedRoutingForPublicStatus(routebook, { allowUnverifiedRouting: true, routingOverrideReason: '过短' }));
  assert.equal(
    requireVerifiedRoutingForPublicStatus(routebook, { allowUnverifiedRouting: true, routingOverrideReason: '运营人工核查后例外发布' }).overridden,
    true
  );
  assert.equal(requireVerifiedRoutingForPublicStatus({ ...routebook, routeLegs: [verifiedLeg()] }).overridden, false);
});

test('verified roads drive schedule conflicts; public payload excludes signing proofs', () => {
  const normalized = normalizeRoutebookForStorage({ id: 'road-proof', city: '杭州', stops: stops(), publishStatus: 'published' });
  const leg = verifiedLeg(normalized.stops);
  const routebook = normalizeRoutebookForStorage({ ...normalized, routeLegs: [leg] });
  assert.equal(routebook.routeLegs[0].status, 'verified');
  const stats = summarizeRouteExecution(routebook.stops, routebook.routeLegs);
  assert.equal(stats.totalDurationSeconds, 1800);
  assert.equal(routeExecutionValidationRows(stats).find((item) => item.id === 'edit-tempo').state, '时间冲突');
  const view = publicRoutebookView(routebook);
  assert.equal(view.routeLegs[0].status, 'verified');
  assert.equal('proof' in view.routeLegs[0], false);
  assert.equal(roadSummary(view.stops, view.routeLegs).distanceKm, 2.2);
});

test('admin helper makes normal request first and never silently overrides', async () => {
  const calls = [];
  const request = async (_id, body) => {
    calls.push(body);
    if (!body.allowUnverifiedRouting) throw Object.assign(new Error('道路未核验'), { code: 'ROUTEBOOK_ROUTING_UNVERIFIED' });
    return { ok: true };
  };
  const cancelled = await submitRoutebookStatusWithRoutingGate({
    publicId: 'r1',
    payload: { publishStatus: 'published' },
    routebookTitle: '测试',
    request,
    confirmOverride: () => false
  });
  assert.equal(cancelled.cancelled, true);
  assert.equal(calls.length, 1);
  const result = await submitRoutebookStatusWithRoutingGate({
    publicId: 'r1',
    payload: { publishStatus: 'published' },
    routebookTitle: '测试',
    request,
    confirmOverride: () => true,
    promptReason: () => '人工核实后谨慎例外发布'
  });
  assert.equal(result.overridden, true);
  assert.equal(calls.at(-1).allowUnverifiedRouting, true);
});

test('adjacent stops on a transit route: Amap returns no transit plan, so the leg is verified as a short walk', async () => {
  const paths = [];
  const provider = createAmapRoutingProvider({
    apiKey: 'fake-test-key',
    fetchImpl: async (url) => {
      const target = new URL(url);
      paths.push(target.pathname);
      if (target.pathname.includes('transit')) return new Response(JSON.stringify({ status: '1', route: { distance: '180', transits: [] } }));
      return new Response(
        JSON.stringify({
          status: '1',
          route: { paths: [{ distance: '190', duration: '160', steps: [{ polyline: '120.157000,30.256000;120.158000,30.257000' }] }] }
        })
      );
    }
  });
  const [leg] = await buildRouteLegs({ stops: stops(), provider, city: '杭州', defaultMode: 'transit', now: () => new Date('2026-10-09T00:00:00Z') });
  assert.deepEqual(paths, ['/v3/direction/transit/integrated', '/v3/direction/walking']);
  assert.equal(leg.status, 'verified');
  assert.equal(leg.mode, 'transit');
  assert.equal(leg.walkingOnly, true);
  assert.equal(leg.distanceMeters, 190);
});

test('a far transit leg with no plan stays unverified instead of pretending to be a walk', async () => {
  const provider = createAmapRoutingProvider({
    apiKey: 'fake-test-key',
    fetchImpl: async () => new Response(JSON.stringify({ status: '1', route: { distance: '9000', transits: [] } }))
  });
  const [leg] = await buildRouteLegs({ stops: stops(), provider, city: '杭州', defaultMode: 'transit' });
  assert.equal(leg.status, 'unverified');
  assert.equal(leg.error.code, 'ROUTING_ROUTE_NOT_FOUND');
});

test('a walk-only transit leg is labelled as a walk, not 公共交通', async () => {
  const { roadLegLabel } = await import('../../src/lib/routeRoads.js');
  assert.match(roadLegLabel({ mode: 'transit', walkingOnly: true, distanceMeters: 190, durationSeconds: 160 }), /^步行（距离近，无需乘车） 0\.2 km/);
  assert.match(roadLegLabel({ mode: 'transit', distanceMeters: 3563, durationSeconds: 1732 }), /^公共交通 3\.6 km/);
});

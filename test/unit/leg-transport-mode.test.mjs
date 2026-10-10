import assert from 'node:assert/strict';
import { test } from 'node:test';
import { plannedLegMode, normalizeStoredRouteLegs, WALKING_LEG_MAX_METERS } from '../../server/routing/provenance.mjs';
import { attachServerRouteLegs } from '../../server/routing/service.mjs';

// Hangzhou: s1→s2 ≈ 0.6 km, s2→s3 ≈ 4.9 km, s3→s4 ≈ 8.5 km (straight line).
const stop = (id, lat, lng, extra = {}) => ({ id, day: 'Day 1', name: id, lat, lng, coordinateSystem: 'WGS84', geoConfidence: 92, ...extra });
const s1 = stop('s1', 30.2588, 120.1525);
const s2 = stop('s2', 30.2556, 120.147);
const s3 = stop('s3', 30.214, 120.136);
const s4 = stop('s4', 30.29, 120.13);

test('mixed walking + taxi preference walks short hops and rides long ones', () => {
  assert.equal(plannedLegMode(s1, s2, '步行 + 打车'), 'walking');
  assert.equal(plannedLegMode(s2, s3, '步行 + 打车'), 'driving');
  assert.equal(plannedLegMode(s3, s4, '步行 + 打车'), 'driving');
  assert.equal(plannedLegMode(s3, s4, '步行 + 地铁'), 'transit');
  assert.equal(plannedLegMode(s3, s4, '步行/公交/打车'), 'transit');
  assert.ok(WALKING_LEG_MAX_METERS >= 1000);
});

test('explicit stop mode and single-mode preferences win; missing data falls back safely', () => {
  assert.equal(plannedLegMode(s3, { ...s4, transportMode: 'transit' }, '步行 + 打车'), 'transit');
  assert.equal(plannedLegMode(s1, s2, '自驾'), 'driving');
  assert.equal(plannedLegMode(s3, s4, '纯步行'), 'walking');
  assert.equal(plannedLegMode(s3, s4, ''), 'driving');
  assert.equal(plannedLegMode(s1, s2, ''), 'walking');
  assert.equal(plannedLegMode({ id: 'x' }, { id: 'y' }, '步行 + 打车'), 'walking');
});

test('recheck verifies each leg with its planned mode and the proof survives storage', async () => {
  const seen = [];
  const provider = {
    id: 'amap',
    route: async ({ mode, fromStop, toStop }) => {
      seen.push(`${fromStop.id}>${toStop.id}:${mode}`);
      return {
        status: 'verified',
        mode,
        distanceMeters: 1000,
        durationSeconds: 60,
        geometry: [
          [fromStop.lat, fromStop.lng],
          [toStop.lat, toStop.lng]
        ]
      };
    }
  };
  const routebook = { id: 'rb', city: '杭州', constraints: { transport: '步行 + 打车' }, stops: [s1, s2, s3, s4] };
  const out = await attachServerRouteLegs(routebook, undefined, /** @type {any} */ (provider));
  assert.deepEqual(seen.sort(), ['s1>s2:walking', 's2>s3:driving', 's3>s4:driving']);
  assert.deepEqual(
    out.routeLegs.map((leg) => `${leg.mode}:${leg.status}`),
    ['walking:verified', 'driving:verified', 'driving:verified']
  );
  const stored = normalizeStoredRouteLegs(out.routeLegs, routebook.stops, routebook.constraints.transport);
  assert.deepEqual(
    stored.map((leg) => leg.status),
    ['verified', 'verified', 'verified']
  );
});

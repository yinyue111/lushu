import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachServerRouteLegs } from '../../server/routing/service.mjs';
import { signRouteLeg } from '../../server/routing/provenance.mjs';

const stops = [
  { id: 1, name: 'A', day: 'Day 1', lat: 30.65, lng: 104.07, geoConfidence: 92 },
  { id: 2, name: 'B', day: 'Day 1', lat: 30.66, lng: 104.08, geoConfidence: 92 },
  { id: 3, name: 'C', day: 'Day 1', lat: 30.67, lng: 104.05, geoConfidence: 92 }
];

/** @returns {any} */
function fakeProvider() {
  const calls = [];
  return {
    calls,
    id: 'amap',
    configured: true,
    async route({ fromStop, toStop, mode }) {
      calls.push(`${fromStop.id}->${toStop.id}`);
      return {
        status: 'verified',
        provider: 'amap',
        mode,
        distanceMeters: 1000,
        durationSeconds: 600,
        geometry: [
          [30.65, 104.07],
          [30.66, 104.08]
        ]
      };
    }
  };
}

test('E2E 2026-10-09: an ops re-check only re-queries legs that are not still verified', async () => {
  const first = await attachServerRouteLegs({ city: '成都', stops, constraints: { transport: '步行' } }, undefined, fakeProvider());
  assert.equal(first.routeLegs.filter((leg) => leg.status === 'verified').length, 2);
  const oldQueriedAt = first.routeLegs[0].queriedAt;
  // Leg 2->3 lost its verification (e.g. a touched stop); leg 1->2 keeps its proof.
  const routeLegs = [first.routeLegs[0], { ...first.routeLegs[1], status: 'unverified', proof: undefined }];
  const provider = fakeProvider();
  const again = await attachServerRouteLegs({ city: '成都', stops, constraints: { transport: '步行' }, routeLegs }, undefined, provider, {
    reuseVerifiedLegs: true
  });
  assert.deepEqual(provider.calls, ['2->3']);
  assert.equal(
    again.routeLegs.every((leg) => leg.status === 'verified'),
    true
  );
  assert.equal(again.routeLegs[0].queriedAt, oldQueriedAt);
  assert.equal(again.routeLegs[0].proof, signRouteLeg(again.routeLegs[0], stops[0], stops[1]));
});

test('without reuse every leg is queried (generation path unchanged)', async () => {
  const provider = fakeProvider();
  await attachServerRouteLegs({ city: '成都', stops, constraints: { transport: '步行' } }, undefined, provider);
  assert.deepEqual(provider.calls.sort(), ['1->2', '2->3']);
});

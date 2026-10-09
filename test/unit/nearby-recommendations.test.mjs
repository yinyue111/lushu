import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildNearbyFacilities,
  filterNearbyRecommendations,
  hasNearbyCoordinate,
  normalizeFacilityType,
  trustedKnowledgeStop
} from '../../src/lib/nearbyRecommendations.js';

const current = { id: 'current', name: '当前站点', city: '杭州', lat: 30.242, lng: 120.1617, geoConfidence: 95 };
const routebook = { city: '杭州', stops: [current] };

test('nearby candidates require explicit coordinates and platform verification', () => {
  assert.equal(hasNearbyCoordinate({ lat: null, lng: '', geoConfidence: 99 }), false);
  assert.equal(trustedKnowledgeStop({ name: '柳浪闻莺', city: '杭州' }, '杭州'), null);
  assert.equal(trustedKnowledgeStop({ ...current, id: 'unverified' }, '杭州'), null);
  assert.equal(trustedKnowledgeStop({ ...current, navigationReady: true }, '上海'), null);
  const trusted = trustedKnowledgeStop({ trustedPoi: { ...current, navigationReady: true } }, '杭州市');
  assert.equal(trusted.name, current.name);
  assert.ok(hasNearbyCoordinate(trusted));
});

test('facility category is structured, reviewed and city scoped', () => {
  const stops = [
    { ...current, id: 'name-only', name: '公共厕所旁咖啡馆', lat: 30.243 },
    { ...current, id: 'toilet', name: '受控设施A', lat: 30.244, facilityType: 'public_toilet', facilityReviewStatus: 'approved' },
    { ...current, id: 'rest', name: '受控设施B', lat: 30.245, facilityType: 'rest_point', facilityReviewStatus: 'pending' },
    { ...current, id: 'other-city', city: '上海', lat: 30.246, facilityType: 'toilet', facilityReviewStatus: 'approved' },
    { ...current, id: 'rejected', lat: 30.246, facilityType: 'toilet', facilityReviewStatus: 'rejected' }
  ];
  const facilities = buildNearbyFacilities({ current, routebook: { ...routebook, stops } });
  assert.deepEqual(
    facilities.map((item) => item.name),
    ['受控设施A', '受控设施B']
  );
  assert.equal(facilities[0].canNavigate, true);
  assert.equal(facilities[1].canNavigate, false);
  assert.equal(filterNearbyRecommendations(facilities, 'toilet').length, 1);
  assert.equal(filterNearbyRecommendations(facilities, 'alternative').length, 0);
  assert.equal(normalizeFacilityType('卫生间'), 'toilet');
  assert.equal(normalizeFacilityType('咖啡馆'), '');
  assert.deepEqual(buildNearbyFacilities({ current: { ...current, geoConfidence: 30 }, routebook }), []);
});

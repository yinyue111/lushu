import assert from 'node:assert/strict';
import { buildProductFunnelAnalytics, productExposureMatchesClick } from '../server/analytics/productFunnel.mjs';

const exposure = {
  id: 'exp-1',
  exposureId: 'exp-1',
  profileId: 'profile-1',
  sessionId: 'session-1',
  surface: 'poi-detail',
  itemType: 'product',
  itemId: 'product-1',
  productId: 'product-1',
  productTitle: '西湖游船',
  routeId: 'route-1',
  routeTitle: '西湖一日',
  stopId: 'stop-1',
  stopName: '柳浪闻莺',
  creatorId: 'creator-1',
  provider: 'provider-1',
  type: '门票',
  createdAt: '2026-08-24T10:00:00.000Z'
};
const click = {
  ...exposure,
  id: 'click-1',
  exposureId: exposure.id,
  itemType: undefined,
  createdAt: '2026-08-24T10:01:00.000Z'
};

assert.equal(productExposureMatchesClick(exposure, click), true);
assert.equal(productExposureMatchesClick(exposure, { ...click, productId: 'product-2' }), false);
assert.equal(productExposureMatchesClick(exposure, { ...click, sessionId: 'other-session' }), false);
assert.equal(productExposureMatchesClick(exposure, { ...click, routeId: 'other-route' }), false);
assert.equal(productExposureMatchesClick(exposure, { ...click, surface: 'other-surface' }), false);
assert.equal(productExposureMatchesClick(exposure, { ...click, stopId: 'other-stop' }), false);
assert.equal(productExposureMatchesClick({ ...exposure, stopId: '' }, click), false, '缺失 stopId 的曝光不得匹配带 stopId 的点击');

const analytics = buildProductFunnelAnalytics({
  exposures: [exposure, { ...exposure, id: 'exp-2', exposureId: 'exp-2', productId: 'product-2', itemId: 'product-2' }],
  clicks: [
    click,
    { ...click, id: 'click-duplicate', createdAt: '2026-08-24T10:02:00.000Z' },
    { ...click, id: 'click-orphan', exposureId: 'missing-exposure' },
    { ...click, id: 'click-mismatch', exposureId: 'exp-2', productId: 'product-mismatch' }
  ]
});
assert.equal(analytics.totalExposures, 2);
assert.equal(analytics.totalClicks, 1);
assert.equal(analytics.rawClickCount, 4);
assert.equal(analytics.duplicateClickCount, 1);
assert.equal(analytics.unattributedClickCount, 2);
assert.equal(analytics.overallCtr, 50);
assert.equal(analytics.ctrByProduct.find((row) => row.key === 'product-1')?.ctr, 100);
assert.equal(analytics.ctrByProduct.find((row) => row.key === 'product-2')?.ctr, 0);
assert.deepEqual(
  analytics.funnelByPoi.map((row) => [row.key, row.exposureCount, row.clickCount, row.ctr]),
  [['route-1:stop-1', 2, 1, 50]]
);
assert.deepEqual(
  analytics.funnelByRoute.map((row) => [row.key, row.exposureCount, row.clickCount, row.ctr]),
  [['route-1', 2, 1, 50]]
);
assert.equal(analytics.funnelByCreator[0]?.key, 'creator-1');
assert.equal(analytics.recentClicks.length, 1);

const scoped = buildProductFunnelAnalytics({ clicks: [click], exposures: [exposure], profileId: 'other-profile' });
assert.equal(scoped.totalExposures, 0);
assert.equal(scoped.totalClicks, 0);

console.log('product funnel regression: ok');

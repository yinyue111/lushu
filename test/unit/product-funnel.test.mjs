import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildProductFunnelAnalytics, productExposureMatchesClick } from '../../server/analytics/productFunnel.mjs';

test('historical raw clicks and unlinked impressions do not produce synthetic CTR', () => {
  const result = buildProductFunnelAnalytics({
    clicks: [{ id: 'old-click', productId: 'p1' }],
    exposures: [{ id: 'old-exposure', itemType: 'product', productId: 'p1' }]
  });
  assert.equal(result.totalClicks, 0);
  assert.equal(result.totalExposures, 0);
  assert.equal(result.overallCtr, null);
  assert.equal(result.rawClickCount, 1);
  assert.equal(result.unattributedClickCount, 1);
  assert.equal(result.rawExposureCount, 1);
  assert.equal(result.unattributedExposureCount, 1);
  assert.equal(result.rawRecentClicks[0].attributionStatus, 'unattributed');
});

test('no scope field may be silently widened and duplicate clicks cannot inflate CTR', () => {
  const exposure = {
    id: 'exp-1',
    exposureId: 'exp-1',
    sessionId: 'session-1',
    profileId: 'owner-1',
    itemType: 'product',
    productId: 'p1',
    surface: 'poi-detail',
    routeId: 'r1',
    stopId: 's1'
  };
  const click = { ...exposure, id: 'click-1' };
  assert.equal(productExposureMatchesClick(exposure, click), true);
  for (const key of ['sessionId', 'profileId', 'productId', 'surface', 'routeId', 'stopId'])
    assert.equal(productExposureMatchesClick(exposure, { ...click, [key]: '' }), false, key);
  const result = buildProductFunnelAnalytics({ exposures: [exposure, exposure], clicks: [click, { ...click, id: 'click-2' }, { id: 'raw', productId: 'p1' }] });
  assert.equal(result.totalExposures, 1);
  assert.equal(result.totalClicks, 1);
  assert.equal(result.duplicateClickCount, 1);
  assert.equal(result.unattributedClickCount, 1);
  assert.equal(result.overallCtr, 100);
});

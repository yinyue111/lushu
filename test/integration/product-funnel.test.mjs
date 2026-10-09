import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adminHeaders, fetchJson, jsonHeaders, startServer } from '../helpers/server.mjs';

test('product exposures and clicks are scope-matched and replay-idempotent; raw clicks remain separate', async (t) => {
  const server = await startServer();
  t.after(server.stop);
  const post = (path, body) => fetchJson(`${server.baseUrl}${path}`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(body) });
  const payload = {
    itemType: 'product',
    productId: 'seed-funnel-test',
    productTitle: '归因回归商品',
    linkType: 'seed-search',
    sessionId: 'session-funnel-test',
    exposureId: 'exposure-funnel-test',
    surface: 'poi-detail',
    routeId: 'test-route',
    stopId: 's1',
    stopName: '测试站点'
  };
  const exposure = await post('/api/exposures', payload);
  assert.equal(exposure.status, 200, JSON.stringify(exposure.data));
  assert.equal(exposure.data.exposure.exposureId, payload.exposureId);
  const replayedExposure = await post('/api/exposures', payload);
  assert.equal(replayedExposure.data.deduplicated, true);
  const conflict = await post('/api/exposures', { ...payload, productId: 'seed-other-product' });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.code, 'PRODUCT_EXPOSURE_CONFLICT');
  const mismatch = await post('/api/clicks', { ...payload, sessionId: 'different-session' });
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.data.code, 'PRODUCT_EXPOSURE_MISMATCH');
  const missing = await post('/api/clicks', { ...payload, exposureId: 'missing-exposure-id' });
  assert.equal(missing.status, 400);
  assert.equal(missing.data.code, 'PRODUCT_EXPOSURE_REQUIRED');
  const clicks = await Promise.all([post('/api/clicks', payload), post('/api/clicks', payload)]);
  assert.ok(
    clicks.every((result) => result.status === 200),
    JSON.stringify(clicks.map((result) => result.data))
  );
  assert.equal(clicks[0].data.click.id, clicks[1].data.click.id);
  assert.equal(clicks.filter((result) => result.data.deduplicated).length, 1);
  const raw = await post('/api/clicks', { productId: payload.productId, linkType: 'seed-search', surface: 'poi-detail' });
  assert.equal(raw.status, 200);
  assert.equal(raw.data.click.attributionStatus, 'unattributed');
  const { data } = await fetchJson(`${server.baseUrl}/api/product-analytics`, { headers: adminHeaders() });
  assert.equal(data.analytics.totalExposures, 1);
  assert.equal(data.analytics.totalClicks, 1);
  assert.equal(data.analytics.rawClickCount, 2);
  assert.equal(data.analytics.unattributedClickCount, 1);
  assert.equal(data.analytics.overallCtr, 100);
  assert.equal(data.analytics.rawRecentClicks.length, 2);
});

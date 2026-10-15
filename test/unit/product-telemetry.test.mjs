import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordProductClick, recordProductExposure } from '../../src/lib/productTelemetry.js';

test('client waits for render-time exposure and never manufactures impressions on click', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(String(options.body));
    calls.push({ url: String(url), body });
    if (String(url).endsWith('/exposures')) {
      if (body.productId === 'failed-render') throw new Error('offline');
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response(JSON.stringify({ exposure: body }));
    }
    return new Response(JSON.stringify({ click: body }));
  };
  const payload = { profileId: 'anonymous', productId: 'p1', routeId: 'r1', surface: 'route-products' };
  const exposure = recordProductExposure(payload);
  const click = await recordProductClick(payload);
  await exposure;
  assert.equal(calls.length, 2);
  assert.ok(calls[0].url.endsWith('/exposures'));
  assert.ok(calls[1].url.endsWith('/clicks'));
  assert.equal(click.click.exposureId, calls[0].body.exposureId);
  assert.equal(click.click.sessionId, calls[0].body.sessionId);
  const raw = await recordProductClick({ ...payload, productId: 'not-rendered' });
  assert.equal(raw.click.exposureId, '');
  assert.equal(calls.length, 3);
  assert.ok(calls[2].url.endsWith('/clicks'));
  const failed = { ...payload, productId: 'failed-render' };
  await assert.rejects(recordProductExposure(failed), (/** @type {any} */ error) => error.code === 'NETWORK_OFFLINE' && error.cause?.message === 'offline');
  const fallback = await recordProductClick(failed);
  assert.equal(fallback.click.exposureId, '');
  assert.equal(calls.length, 5, 'failed impression must not be retried or fabricated by click path');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { NO_POI_CATALOG, createRouter, route } from '../../server/http/router.mjs';
import { createApiHandler } from '../../server/routes/index.mjs';

function fakeRes() {
  /** @type {any} */
  const res = new EventEmitter();
  Object.assign(res, {
    statusCode: 0,
    headersSent: false,
    setHeader() {},
    getHeader() {},
    writeHead(status) {
      res.statusCode = status;
      return res;
    },
    end() {}
  });
  return res;
}

const request = (method, url) => /** @type {any} */ ({ method, url, headers: { host: 'localhost' } });

test('route() defaults to requiring a fresh POI catalog (fail-safe) and NO_POI_CATALOG opts out', () => {
  assert.equal(route('GET', '/a', () => {}).poiCatalog, true);
  assert.equal(route('GET', '/a', () => {}, NO_POI_CATALOG).poiCatalog, false);
});

test('the API entry refreshes the POI catalog only for routes that resolve POIs', async () => {
  let refreshes = 0;
  const handled = [];
  const handler = createApiHandler({
    router: createRouter([
      route('GET', '/api/live', () => handled.push('live'), NO_POI_CATALOG),
      route('GET', '/api/routebooks/:id', () => handled.push('routebook'))
    ]),
    refreshCatalog: async () => {
      refreshes += 1;
    }
  });
  await handler(request('GET', '/api/live'), fakeRes());
  assert.equal(refreshes, 0, 'health probe must not reload the catalog');
  await handler(request('GET', '/api/routebooks/rb-1'), fakeRes());
  assert.equal(refreshes, 1);
  const missing = fakeRes();
  await handler(request('GET', '/api/nope'), missing);
  assert.equal(refreshes, 1, 'unknown paths never touch the catalog');
  assert.equal(missing.statusCode, 404);
  assert.deepEqual(handled, ['live', 'routebook']);
});

test('the production route table only opts out health/tiles/cities and read-only ops listings', async () => {
  const { systemRoutes } = await import('../../server/routes/system.mjs');
  const { opsRoutes } = await import('../../server/routes/ops.mjs');
  const { poiRoutes } = await import('../../server/routes/poi.mjs');
  const { routebookRoutes } = await import('../../server/routes/routebooks.mjs');
  const { tripRoutes } = await import('../../server/routes/trips.mjs');
  const optedOut = [...systemRoutes, ...opsRoutes, ...poiRoutes, ...routebookRoutes, ...tripRoutes]
    .filter((item) => !item.poiCatalog)
    .map((item) => `${item.method} ${item.pattern}`)
    .sort();
  assert.deepEqual(optedOut, [
    'GET /api/cities',
    'GET /api/health',
    'GET /api/live',
    'GET /api/map-tiles/*',
    'GET /api/ops/audits',
    'GET /api/ops/review-queue',
    'GET /api/ops/shadow-judgments',
    'GET /api/ops/users',
    'GET /api/ready',
    'POST /api/ops/users/:id'
  ]);
});

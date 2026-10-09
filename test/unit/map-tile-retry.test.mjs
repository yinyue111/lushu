import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchTileWithRetry, normalizeTileUpstreamError } from '../../server/http/map-tiles.mjs';

function resetError() {
  return Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
}

test('map tile proxy retries once after an upstream connection reset', async () => {
  let calls = 0;
  const tile = await fetchTileWithRetry(
    async () => {
      calls += 1;
      if (calls === 1) throw resetError();
      return { body: Buffer.from('png'), source: 'amap' };
    },
    { id: 'amap' },
    { z: 13, x: 1, y: 1 },
    new AbortController().signal
  );
  assert.equal(calls, 2);
  assert.equal(tile.source, 'amap');
});

test('map tile proxy maps a repeated reset to 502 MAP_TILE_UPSTREAM_NETWORK, not 500', async () => {
  let calls = 0;
  await assert.rejects(
    fetchTileWithRetry(
      async () => {
        calls += 1;
        throw resetError();
      },
      { id: 'amap' },
      {},
      new AbortController().signal
    ),
    (/** @type {any} */ error) =>
      error.statusCode === 502 && error.code === 'MAP_TILE_UPSTREAM_NETWORK' && error.upstreamCode === 'ECONNRESET' && !/https?:|key=/.test(error.message)
  );
  assert.equal(calls, 2);
});

test('map tile proxy does not retry HTTP-level upstream errors', async () => {
  let calls = 0;
  const httpError = Object.assign(new Error('地图上游返回 HTTP 403'), { statusCode: 502, code: 'MAP_TILE_UPSTREAM_ERROR' });
  await assert.rejects(
    fetchTileWithRetry(
      async () => {
        calls += 1;
        throw httpError;
      },
      { id: 'amap' },
      {},
      new AbortController().signal
    ),
    (/** @type {any} */ error) => error === httpError
  );
  assert.equal(calls, 1);
  assert.equal(normalizeTileUpstreamError(httpError), httpError);
});

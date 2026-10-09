import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPacedAmapFetch } from '../../server/geo/amapPacer.mjs';

function jsonResponse(data) {
  const body = JSON.stringify(data);
  return {
    ok: true,
    status: 200,
    json: async () => JSON.parse(body),
    clone() {
      return jsonResponse(data);
    }
  };
}

function fakeClock() {
  let t = 0;
  const sleeps = [];
  return {
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps
  };
}

test('calls are spaced to the configured QPS', async () => {
  // Concurrent callers: the clock does not move while they wait, so each wait is its slot offset.
  const clock = { now: () => 0, sleeps: [], sleep: async (ms) => void clock.sleeps.push(ms) };
  const calls = [];
  const paced = createPacedAmapFetch({
    qps: 3,
    now: clock.now,
    sleep: clock.sleep,
    fetchImpl: async (url) => {
      calls.push([url, clock.now()]);
      return jsonResponse({ status: '1' });
    }
  });
  await Promise.all([paced('a'), paced('b'), paced('c')]);
  assert.equal(calls.length, 3);
  assert.deepEqual(clock.sleeps, [334, 668]);
});

test('E2E 2026-10-09: a 10021 CUQPS rejection is retried once and the retry result is returned', async () => {
  const clock = fakeClock();
  let n = 0;
  const paced = createPacedAmapFetch({
    qps: 3,
    now: clock.now,
    sleep: clock.sleep,
    fetchImpl: async () =>
      ++n === 1 ? jsonResponse({ status: '0', infocode: '10021', info: 'CUQPS_HAS_EXCEEDED_THE_LIMIT' }) : jsonResponse({ status: '1', count: '1' })
  });
  const data = await (await paced('https://restapi.amap.com/v3/place/text?key=SECRET')).json();
  assert.equal(n, 2);
  assert.equal(data.status, '1');
  assert.ok(clock.sleeps.includes(1100));
});

test('non-QPS rejections (bad key) are not retried', async () => {
  let n = 0;
  const paced = createPacedAmapFetch({
    qps: 100,
    fetchImpl: async () => {
      n += 1;
      return jsonResponse({ status: '0', infocode: '10001', info: 'INVALID_USER_KEY' });
    }
  });
  const data = await (await paced('x')).json();
  assert.equal(n, 1);
  assert.equal(data.infocode, '10001');
});

test('a second QPS rejection is returned as-is (no retry loop)', async () => {
  let n = 0;
  const clock = fakeClock();
  const paced = createPacedAmapFetch({
    qps: 3,
    now: clock.now,
    sleep: clock.sleep,
    fetchImpl: async () => {
      n += 1;
      return jsonResponse({ status: '0', infocode: '10021' });
    }
  });
  const data = await (await paced('x')).json();
  assert.equal(n, 2);
  assert.equal(data.infocode, '10021');
});

test('pacing honours abort', async () => {
  const controller = new AbortController();
  const paced = createPacedAmapFetch({ qps: 1, fetchImpl: async () => jsonResponse({ status: '1' }) });
  await paced('first', { signal: controller.signal });
  const pending = paced('second', { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (/** @type {any} */ error) => error.name === 'AbortError');
});

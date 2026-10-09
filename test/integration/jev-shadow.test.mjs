import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { API_TOKEN, adminHeaders, fetchJson, jsonHeaders, startServer } from '../helpers/server.mjs';
import { createJevMockServer } from '../../scripts/jev/mock-server.mjs';

/** @param {any} server */
async function importGuide(server) {
  return fetchJson(`${server.baseUrl}/api/import-guide`, {
    method: 'POST',
    headers: jsonHeaders({ 'x-routebook-token': API_TOKEN }),
    body: JSON.stringify({ urls: ['http://127.0.0.1:1/private'], city: '杭州' })
  });
}

test('jev shadow: disabled by default — no calls, no rows, same import response', async (t) => {
  const server = await startServer();
  t.after(server.stop);
  const result = await importGuide(server);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  const summary = await fetchJson(`${server.baseUrl}/api/ops/shadow-judgments`, { headers: adminHeaders() });
  assert.equal(summary.status, 200);
  assert.equal(summary.data.enabled, false);
  assert.equal(summary.data.rowCount, 0);
  assert.ok([401, 403].includes((await fetchJson(`${server.baseUrl}/api/ops/shadow-judgments`)).status));
});

test('jev shadow: enabled against the mock, import gate is judged in the background', async (t) => {
  const mock = createJevMockServer({ apiKey: 'mock-key' });
  await new Promise((resolve) => mock.server.listen(0, '127.0.0.1', () => resolve(undefined)));
  t.after(() => new Promise((resolve) => mock.server.close(() => resolve(undefined))));
  const address = /** @type {any} */ (mock.server.address());
  const server = await startServer({
    env: {
      JEV_SHADOW_ENABLED: 'true',
      TYPESAFE_API_KEY: 'mock-key',
      JEV_API_URL: `http://127.0.0.1:${address.port}/v1/systemone`
    }
  });
  t.after(server.stop);
  const result = await importGuide(server);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.sources[0].status, 'failed', 'the product decision is unchanged');
  let summary;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    summary = await fetchJson(`${server.baseUrl}/api/ops/shadow-judgments`, { headers: adminHeaders() });
    if (summary.data.rowCount > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(summary?.data.enabled, true);
  assert.equal(summary?.data.tasks['import-gate'].ok, 1, JSON.stringify(summary?.data));
  // Mock answers 0.5 for is_travel_content → not usable; the rule also said not usable.
  assert.equal(summary?.data.tasks['import-gate'].agreementRate, 100);
  assert.equal(mock.requests.length, 2);
  assert.equal(mock.requests[0].state.selectedCity, '杭州');
  const raw = await readFile(join(server.dataDir, 'shadow-judgments.jsonl'), 'utf8').catch(() => '');
  assert.ok(!/profileId|x-routebook-token/.test(raw));
});

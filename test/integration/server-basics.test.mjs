import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fetchJson, startServer } from '../helpers/server.mjs';

let server;
before(async () => { server = await startServer(); });
after(async () => { await server?.stop(); });

test('live and ready endpoints respond with hermetic fake model config', async () => {
  const live = await fetchJson(`${server.baseUrl}/api/live`);
  assert.equal(live.status, 200);
  assert.equal(live.data.live, true);
  const ready = await fetchJson(`${server.baseUrl}/api/ready`);
  assert.equal(ready.status, 200, JSON.stringify(ready.data));
  assert.equal(ready.data.ready, true);
});

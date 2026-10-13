import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startServer } from '../helpers/server.mjs';

test('.map files are never served publicly', async (t) => {
  const server = await startServer();
  t.after(server.stop);
  const res = await fetch(`${server.baseUrl}/assets/index.js.map`);
  assert.equal(res.status, 404);
});

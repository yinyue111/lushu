import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { IDENTITY_SECRET, fetchJson, jsonHeaders, startServer } from '../helpers/server.mjs';

function phoneAssertion(phone, nonce = randomUUID().replace(/-/g, '')) {
  const issuedAt = new Date().toISOString();
  const signature = createHmac('sha256', IDENTITY_SECRET)
    .update(`trusted-routebook:phone:${phone}:${issuedAt}:${nonce}`)
    .digest('hex');
  return { phone, proof: { issuedAt, nonce, signature } };
}

async function bind(baseUrl, identity) {
  return fetchJson(`${baseUrl}/api/profile`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ identity, homeCity: '杭州' })
  });
}

test('M1: an identity assertion cannot be replayed to rotate the profile token', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'routebook-nonce-'));
  const phone = '13800001234';
  const assertion = phoneAssertion(phone);
  let server = await startServer({ dataDir });
  try {
    const first = await bind(server.baseUrl, assertion);
    assert.equal(first.status, 200, JSON.stringify(first.data));
    assert.equal(first.data.profile.identityBound, true);

    const replay = await bind(server.baseUrl, assertion);
    assert.equal(replay.status, 409, JSON.stringify(replay.data));
    assert.equal(replay.data.code, 'IDENTITY_ASSERTION_REPLAYED');

    const concurrent = await Promise.all([1, 2, 3].map(() => bind(server.baseUrl, assertion)));
    assert.deepEqual(concurrent.map((item) => item.status), [409, 409, 409]);
  } finally {
    await server.stop();
  }

  server = await startServer({ dataDir });
  try {
    const afterRestart = await bind(server.baseUrl, assertion);
    assert.equal(afterRestart.status, 409, 'replay window does not reopen after a restart');

    // Legitimate device switch with a fresh assertion still recovers the profile.
    const recovery = await bind(server.baseUrl, phoneAssertion(phone));
    assert.equal(recovery.status, 200, JSON.stringify(recovery.data));
    assert.equal(recovery.data.profile.identityBound, true);
  } finally {
    await server.stop();
  }
});

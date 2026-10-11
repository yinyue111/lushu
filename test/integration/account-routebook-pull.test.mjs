import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { pullAccountRoutebooks } from '../../src/lib/accountRoutebookPull.js';
import { authEnv, createClient, signUpWithEmail } from '../helpers/accounts.mjs';
import { startServer } from '../helpers/server.mjs';

// Regression for prod: after login on a fresh device, cloud drafts must be pullable into local
// storage (homepage only reads localStorage; API list alone is not enough for Home).
const PASSWORD = '西湖边走一走2026';
const generated = {
  title: '首页云端列表回归',
  city: '杭州',
  days: ['第1天'],
  stops: ['断桥', '白堤', '河坊街'].map((name, index) => ({
    name,
    day: '第1天',
    time: `${10 + index}:00`,
    stay: '30分钟',
    cost: '免费',
    area: '杭州',
    geoConfidence: 90
  }))
};

test('pullAccountRoutebooks hydrates local storage from the account list (fresh device after login)', async (t) => {
  const provider = createServer(async (req, res) => {
    req.resume();
    await new Promise((resolve) => req.on('end', resolve));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ output_text: JSON.stringify(generated), usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }));
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', () => resolve(undefined)));
  const port = /** @type {import('node:net').AddressInfo} */ (provider.address()).port;
  const server = await startServer({
    env: authEnv('login', { OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`, GENERATION_DEDUP_TTL_MS: '0' })
  });
  t.after(async () => {
    await server.stop();
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
  });

  const deviceA = createClient(server.baseUrl);
  const registered = await signUpWithEmail(server, deviceA, 'home-list@example.com', { password: PASSWORD });
  assert.equal(registered.status, 200, JSON.stringify(registered.data));
  const profileId = registered.data.account.profileId;

  const started = await deviceA.post('/api/generation-jobs', {
    city: '杭州',
    guide: '杭州：断桥、白堤、河坊街',
    profileId
  });
  assert.ok([200, 202].includes(started.status), JSON.stringify(started.data));
  let job = started.data.job;
  for (let i = 0; i < 40 && !['succeeded', 'failed'].includes(job.status); i += 1) {
    job = (await deviceA.request(`/api/generation-jobs/${job.jobId}?after=${job.seq}`)).data.job;
  }
  assert.equal(job.status, 'succeeded', JSON.stringify(job.error ?? job));
  const id = job.result?.routebook?.publicId || job.result?.publicId || job.result?.id;

  // Fresh device: cookie session only, empty localStorage simulated by empty local array.
  const deviceB = createClient(server.baseUrl);
  assert.equal((await deviceB.post('/api/auth/login', { identifier: 'home-list@example.com', password: PASSWORD })).status, 200);
  /** @type {Record<string, any>[]} */
  const local = [];
  const result = await pullAccountRoutebooks({
    profile: { id: profileId, accountUserId: registered.data.account.id },
    list: async (pid, limit) => {
      const listed = await deviceB.request(`/api/routebooks?profileId=${encodeURIComponent(pid)}&limit=${limit || 80}`);
      assert.equal(listed.status, 200, JSON.stringify(listed.data));
      return listed.data;
    },
    getLocal: () => local,
    persist: (book) => {
      local.push(book);
      return true;
    }
  });
  assert.ok(result.pulled.includes(id), JSON.stringify(result));
  assert.ok(local.some((book) => (book.publicId || book.id) === id && book.stops?.length >= 3));
  // Homepage visibility rule: city + stops + matching profileId.
  assert.ok(local.every((book) => book.profileId === profileId && book.city && book.stops.length));
});

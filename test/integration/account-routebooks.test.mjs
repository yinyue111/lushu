import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { startServer } from '../helpers/server.mjs';
import { authEnv, createClient, signUpWithEmail } from '../helpers/accounts.mjs';

// Routebooks generated while signed in belong to the account: visible from another session,
// deletable only by the owner. Uses a mock model; no real model call.
const PASSWORD = '西湖边走一走2026';
const generated = {
  title: '账号路书测试',
  city: '杭州',
  days: ['第1天'],
  stops: ['柳浪闻莺', '南宋御街', '北山街'].map((name, index) => ({
    name,
    day: '第1天',
    time: `${10 + index}:00`,
    stay: '30分钟',
    cost: '免费',
    area: '杭州',
    geoConfidence: 90
  }))
};

test('routebooks generated while signed in are saved to the account and survive devices', async (t) => {
  const provider = createServer(async (req, res) => {
    req.resume();
    await new Promise((resolve) => req.on('end', resolve));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ output_text: JSON.stringify(generated), usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }));
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', () => resolve(undefined)));
  const port = /** @type {import('node:net').AddressInfo} */ (provider.address()).port;
  const server = await startServer({ env: authEnv('login', { OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`, GENERATION_JOB_POLL_WAIT_MS: '2000' }) });
  t.after(async () => {
    await server.stop();
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
  });

  const phone = createClient(server.baseUrl);
  const registered = await signUpWithEmail(server, phone, 'trip@example.com', { password: PASSWORD });
  assert.equal(registered.status, 200, JSON.stringify(registered.data));
  const profileId = registered.data.account.profileId;

  // Generate while signed in (the client could even send a stale device profile id).
  const started = await phone.post('/api/generation-jobs', { city: '杭州', guide: '西湖一日游：柳浪闻莺、南宋御街、北山街', profileId: 'anonymous' });
  assert.ok([200, 202].includes(started.status), JSON.stringify(started.data));
  let job = started.data.job;
  for (let i = 0; i < 30 && job.status !== 'succeeded' && job.status !== 'failed'; i += 1) {
    job = (await phone.request(`/api/generation-jobs/${job.jobId}?after=${job.seq}&profileId=${profileId}`)).data.job;
  }
  assert.equal(job.status, 'succeeded', JSON.stringify(job.error ?? job));
  const routebook = job.result.routebook ?? job.result;
  const id = routebook.publicId || routebook.id;
  assert.equal(routebook.profileId, profileId, 'saved under the account profile');

  // Another device signs in with the email and sees it in "我的路书".
  const laptop = createClient(server.baseUrl);
  assert.equal((await laptop.post('/api/auth/login', { identifier: 'trip@example.com', password: PASSWORD })).status, 200);
  const list = await laptop.request(`/api/routebooks?profileId=${profileId}`);
  assert.equal(list.status, 200, JSON.stringify(list.data));
  assert.ok(list.data.routebooks.some((book) => (book.publicId || book.id) === id));
  const full = await laptop.request(`/api/routebooks/${id}`);
  assert.equal(full.status, 200);
  assert.equal(full.data.routebook.stops.length, 3);

  // Someone else can neither list nor delete it.
  const other = createClient(server.baseUrl);
  await other.register('13812349999', PASSWORD, { email: 'other@example.com' });
  assert.equal((await other.request(`/api/routebooks?profileId=${profileId}`)).status >= 400, true);
  assert.equal((await other.request(`/api/routebooks/${id}`, { method: 'DELETE' })).status, 403);

  // The owner deletes it from the other device; it is gone everywhere.
  const deleted = await laptop.request(`/api/routebooks/${id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
  assert.equal(deleted.data.deleted, true);
  assert.ok(!(await phone.request(`/api/routebooks?profileId=${profileId}`)).data.routebooks.some((book) => (book.publicId || book.id) === id));
  const gone = await phone.request(`/api/routebooks/${id}`);
  assert.equal(gone.status, 410);
  assert.equal(gone.data.code, 'ROUTEBOOK_DELETED');
  assert.equal((await laptop.request(`/api/routebooks/${id}`, { method: 'DELETE' })).data.alreadyGone, true);

  // The phone still has the old copy: every way of writing it back is refused, clearly.
  const stale = full.data.routebook;
  for (const body of [
    { ...stale, expectedVersion: stale.version },
    { ...stale, expectedVersion: 0, version: 0 },
    { ...stale, expectedVersion: (stale.version || 1) + 1 },
    { ...stale, profileId: 'anonymous' }
  ]) {
    const again = await phone.post('/api/routebooks', body);
    assert.equal(again.status, 410, JSON.stringify(again.data));
    assert.equal(again.data.code, 'ROUTEBOOK_DELETED');
    assert.equal(again.data.details.id, id);
  }
  const variant = await phone.post(`/api/routebooks/${id}/variants`, { variant: { label: 'x', stops: stale.stops } });
  assert.equal(variant.data.code, 'ROUTEBOOK_DELETED');
  const publish = await phone.post(`/api/routebooks/${id}/publish`, {});
  assert.equal(publish.data.code, 'ROUTEBOOK_DELETED');
  // Even a different account (or a guest with the edit token) cannot re-create the id.
  assert.equal((await other.post('/api/routebooks', { ...stale, expectedVersion: 0 })).data.code, 'ROUTEBOOK_DELETED');
  // Claim on login skips it; the batch check reports it so devices drop local copies.
  const claim = await phone.post('/api/auth/claim', { drafts: [{ id, editToken: stale.editToken || 'x'.repeat(32) }] });
  assert.equal(claim.data.claimed, 0);
  const check = await createClient(server.baseUrl).post('/api/routebooks/deleted', { ids: [id, 'not-a-real-id-123', ''] });
  assert.deepEqual(check.data.deleted, [id]);
  assert.ok(!(await phone.request(`/api/routebooks?profileId=${profileId}`)).data.routebooks.some((book) => (book.publicId || book.id) === id));
  // The tombstone keeps owner + id only, not the routebook content.
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const rows = (await readFile(join(server.dataDir, 'routebooks.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  const tomb = rows.filter((r) => (r.publicId || r.id) === id).at(-1);
  assert.equal(tomb.tombstone, true);
  assert.equal(tomb.profileId, profileId);
  assert.equal(tomb.stops, undefined);
});

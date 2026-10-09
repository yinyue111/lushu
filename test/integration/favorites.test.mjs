import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchJson, jsonHeaders, startServer } from '../helpers/server.mjs';
import { activeFavorites } from '../../server/routes/routebooks.mjs';

test('activeFavorites: tombstones hide older rows, re-favorite shows again, duplicates collapse', () => {
  const rows = [
    { id: '5', profileId: 'p_a', routeId: 'r1' },
    { id: '4', type: 'favorite-removed', profileId: 'p_a', routeId: 'r1' },
    { id: '3', profileId: 'p_a', routeId: 'r1' },
    { id: '2', type: 'favorite-removed', profileId: 'p_a', routeId: 'r2' },
    { id: '1', profileId: 'p_a', routeId: 'r2' },
    { id: '0', profileId: 'p_a', routeId: 'r3' },
    { id: '-1', profileId: 'p_a', routeId: 'r3' }
  ];
  assert.deepEqual(
    activeFavorites(rows).map((row) => row.id),
    ['5', '0']
  );
});

test('F14: owners can remove a cloud favorite; other profiles cannot', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'routebook-fav-'));
  const server = await startServer({ dataDir });
  t.after(server.stop);
  const call = (method, path, body, headers = {}) =>
    fetchJson(`${server.baseUrl}${path}`, { method, headers: jsonHeaders(headers), body: body ? JSON.stringify(body) : undefined });
  const owner = (await call('POST', '/api/profile', { creatorName: '收藏测试' })).data.profile;
  const other = (await call('POST', '/api/profile', { creatorName: '别人' })).data.profile;
  const ownerHeaders = { 'x-routebook-profile-id': owner.id, 'x-routebook-profile-token': owner.profileAccessToken };
  const otherHeaders = { 'x-routebook-profile-id': other.id, 'x-routebook-profile-token': other.profileAccessToken };
  for (const routeId of ['route-a', 'route-b']) {
    const created = await call('POST', '/api/favorites', { profileId: owner.id, routeId, routeTitle: routeId }, ownerHeaders);
    assert.equal(created.status, 200, JSON.stringify(created.data));
  }
  const list = () => fetchJson(`${server.baseUrl}/api/favorites?profileId=${owner.id}`, { headers: ownerHeaders });
  assert.deepEqual((await list()).data.favorites.map((row) => row.routeId).sort(), ['route-a', 'route-b']);

  const forged = await call('DELETE', '/api/favorites', { profileId: owner.id, routeId: 'route-a' }, otherHeaders);
  assert.notEqual(forged.status, 200);
  assert.equal((await list()).data.favorites.length, 2);

  const removed = await call('DELETE', '/api/favorites', { profileId: owner.id, routeId: 'route-a' }, ownerHeaders);
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  assert.deepEqual(
    (await list()).data.favorites.map((row) => row.routeId),
    ['route-b']
  );
  const missing = await call('DELETE', '/api/favorites', { profileId: owner.id }, ownerHeaders);
  assert.equal(missing.status, 400);
});

test('list endpoints use their documented default when ?limit is omitted (was clamped to the minimum)', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'routebook-limit-'));
  const { writeJsonl, adminHeaders } = await import('../helpers/server.mjs');
  await writeJsonl(
    dataDir,
    'routebooks.jsonl',
    Array.from({ length: 5 }, (_, index) => ({
      id: `rb-${index}`,
      publicId: `rb-${index}`,
      title: `t${index}`,
      city: '杭州',
      publishStatus: 'published',
      version: 1,
      stops: []
    }))
  );
  const server = await startServer({ dataDir });
  t.after(server.stop);
  const result = await fetchJson(`${server.baseUrl}/api/routebooks?status=published`);
  assert.equal(result.data.routebooks.length, 5);
  const admin = await fetchJson(`${server.baseUrl}/api/routebooks`, { headers: adminHeaders() });
  assert.equal(admin.data.routebooks.length, 5);
});

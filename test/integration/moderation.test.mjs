import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adminHeaders, fetchJson, jsonHeaders, startServer } from '../helpers/server.mjs';

test('moderation: flagged routebook stays private after publication until ops approve; flagged check-in text is queued', async (t) => {
  const server = await startServer();
  t.after(server.stop);
  /** @param {string} path @param {any} body @param {Record<string, string>} [headers] */
  const post = (path, body, headers = {}) =>
    fetchJson(`${server.baseUrl}${path}`, { method: 'POST', headers: jsonHeaders(headers), body: JSON.stringify(body) });
  const draft = await post('/api/routebooks', {
    city: '杭州',
    title: '审核回归',
    summary: '想要攻略原图加微信 travel_12345',
    stops: [
      { id: 's1', day: 'Day 1', name: '断桥残雪', lat: 30.2588, lng: 120.1525 },
      { id: 's2', day: 'Day 1', name: '平湖秋月', lat: 30.2525, lng: 120.1441 }
    ]
  });
  assert.equal(draft.status, 200, JSON.stringify(draft.data));
  const id = draft.data.routebook.publicId;
  const submitted = await post(`/api/routebooks/${id}/publish`, { expectedVersion: 1, editToken: draft.data.routebook.editToken });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.data));
  assert.equal(submitted.data.moderation.status, 'pending');
  await post(`/api/routebooks/${id}/routing`, { expectedVersion: 2 }, adminHeaders());
  const published = await post(
    `/api/routebooks/${id}/status`,
    { expectedVersion: 3, publishStatus: 'published', allowUnverifiedRouting: true, routingOverrideReason: '测试显式人工核验例外说明' },
    adminHeaders()
  );
  assert.equal(published.status, 200, JSON.stringify(published.data));
  assert.equal((await fetchJson(`${server.baseUrl}/api/share/${id}`)).status, 404, 'withheld while pending');
  const publicList = await fetchJson(`${server.baseUrl}/api/routebooks?status=published`);
  assert.ok(!publicList.data.routebooks.some((routebook) => routebook.publicId === id));

  assert.ok([401, 403].includes((await fetchJson(`${server.baseUrl}/api/ops/moderation`)).status));
  const queue = await fetchJson(`${server.baseUrl}/api/ops/moderation`, { headers: adminHeaders() });
  const item = queue.data.items.find((entry) => entry.entityType === 'routebook' && entry.entityId === id);
  assert.ok(item, JSON.stringify(queue.data));
  assert.equal(item.status, 'pending');
  assert.ok(item.hits.some((hit) => hit.category === 'contact-im'));
  assert.equal(item.profileId, undefined, 'ops view carries no profile id');

  const short = await post(`/api/ops/moderation/routebook/${id}`, { action: 'approve', reason: '短' }, adminHeaders());
  assert.equal(short.status, 400);
  const approved = await post(`/api/ops/moderation/routebook/${id}`, { action: 'approve', reason: '人工复核：仅为作者联系方式提示，允许发布' }, adminHeaders());
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  assert.equal(approved.data.item.status, 'approved');
  assert.equal((await fetchJson(`${server.baseUrl}/api/share/${id}`)).status, 200);

  const rejected = await post(`/api/ops/moderation/routebook/${id}`, { action: 'reject', reason: '复核后认定为导流广告，撤下' }, adminHeaders());
  assert.equal(rejected.data.item.status, 'rejected');
  assert.equal((await fetchJson(`${server.baseUrl}/api/share/${id}`)).status, 404);

  const profile = (await post('/api/profile', { creatorName: '审核打卡' })).data.profile;
  const headers = { 'x-routebook-profile-id': profile.id, 'x-routebook-profile-token': profile.profileAccessToken };
  const checkin = await post(
    '/api/checkins',
    { profileId: profile.id, routeId: id, stopId: 's1', stopName: '断桥残雪', worth: '值得', comment: '拍照找我 13912345678' },
    headers
  );
  assert.equal(checkin.status, 200, JSON.stringify(checkin.data));
  assert.equal(checkin.data.moderation.status, 'pending');
  const clean = await post(
    '/api/checkins',
    { profileId: profile.id, routeId: id, stopId: 's2', stopName: '平湖秋月', worth: '值得', comment: '人不多' },
    headers
  );
  assert.equal(clean.data.moderation, undefined);
  const checkinQueue = await fetchJson(`${server.baseUrl}/api/ops/moderation?status=pending`, { headers: adminHeaders() });
  assert.ok(checkinQueue.data.items.some((entry) => entry.entityType === 'checkin' && entry.entityId === checkin.data.checkin.id));
});

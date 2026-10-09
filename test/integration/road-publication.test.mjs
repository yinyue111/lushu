import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adminHeaders, fetchJson, jsonHeaders, startServer } from '../helpers/server.mjs';

test('road publication gate, owner review submission and audited admin override', async (t) => {
  const server = await startServer();
  t.after(server.stop);
  const post = (path, body, admin = false) =>
    fetchJson(`${server.baseUrl}${path}`, { method: 'POST', headers: jsonHeaders(admin ? adminHeaders() : {}), body: JSON.stringify(body) });
  const draft = await post('/api/routebooks', {
    city: '杭州',
    title: '道路门禁回归',
    stops: [
      { id: 's1', day: 'Day 1', name: '断桥残雪', lat: 30.2588, lng: 120.1525 },
      { id: 's2', day: 'Day 1', name: '平湖秋月', lat: 30.2525, lng: 120.1441 }
    ]
  });
  assert.equal(draft.status, 200, JSON.stringify(draft.data));
  const id = draft.data.routebook.publicId;
  const submitted = await post(`/api/routebooks/${id}/publish`, { expectedVersion: 1, editToken: draft.data.routebook.editToken });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.data));
  assert.equal(submitted.data.routebook.publishStatus, 'pending_review');
  assert.equal(submitted.data.shareUrl, '');
  assert.equal((await fetchJson(`${server.baseUrl}/api/share/${id}`)).status, 404);
  const blocked = await post(`/api/routebooks/${id}/status`, { expectedVersion: 2, publishStatus: 'published' }, true);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.code, 'ROUTEBOOK_ROUTING_UNVERIFIED');
  assert.equal((await post(`/api/routebooks/${id}/routing`, { expectedVersion: 2 })).status, 403);
  const rechecked = await post(`/api/routebooks/${id}/routing`, { expectedVersion: 2 }, true);
  assert.equal(rechecked.status, 200, JSON.stringify(rechecked.data));
  assert.equal(rechecked.data.routebook.routeLegs[0].status, 'unverified');
  const published = await post(
    `/api/routebooks/${id}/status`,
    { expectedVersion: 3, publishStatus: 'published', allowUnverifiedRouting: true, routingOverrideReason: '测试显式人工核验例外说明' },
    true
  );
  assert.equal(published.status, 200, JSON.stringify(published.data));
  assert.equal((await fetchJson(`${server.baseUrl}/api/share/${id}`)).status, 200);
  const versions = await fetchJson(`${server.baseUrl}/api/routebooks/${id}/versions`, { headers: adminHeaders() });
  const audit = versions.data.audits.find((item) => item.event === 'status-changed');
  assert.equal(audit.routingPublication.overridden, true);
  assert.equal(audit.routingPublication.routing.unverifiedLegs, 1);
  assert.equal(audit.routingPublication.reason, '测试显式人工核验例外说明');
  // A re-check on a published routebook never unpublishes it: it records a warning.
  const rechecked2 = await post(`/api/routebooks/${id}/routing`, { expectedVersion: 4 }, true);
  assert.equal(rechecked2.status, 200, JSON.stringify(rechecked2.data));
  assert.equal(rechecked2.data.routebook.publishStatus, 'published');
  assert.equal(rechecked2.data.routebook.routingWarning.code, 'ROUTING_UNVERIFIED_AFTER_PUBLISH');
  assert.equal(rechecked2.data.routebook.routingWarning.unverifiedLegs, 1);
  assert.equal(rechecked2.data.routebook.routingWarning.expectedLegs, 1);
  assert.equal((await fetchJson(`${server.baseUrl}/api/share/${id}`)).status, 200, 'share link keeps working');
  const ownerView = await fetchJson(`${server.baseUrl}/api/routebooks/${id}`, { headers: { 'x-routebook-edit-token': draft.data.routebook.editToken } });
  assert.match(ownerView.data.routebook.routingWarning.message, /保持公开/);
  const publicView = await fetchJson(`${server.baseUrl}/api/routebooks/${id}`);
  assert.equal(publicView.data.routebook.routingWarning, undefined, 'warning is for the author and ops only');
  const versionsAfterRecheck = await fetchJson(`${server.baseUrl}/api/routebooks/${id}/versions`, { headers: adminHeaders() });
  const recheckAudit = versionsAfterRecheck.data.audits.filter((item) => item.event === 'routing-checked').at(-1);
  assert.equal(recheckAudit.routingWarning.unverifiedLegs, 1);

  // Ops can still take it down manually, but only with an audit note.
  const noNote = await post(`/api/routebooks/${id}/status`, { expectedVersion: 5, publishStatus: 'pending_review' }, true);
  assert.equal(noNote.status, 400);
  assert.equal(noNote.data.code, 'UNPUBLISH_NOTE_REQUIRED');
  const unpublished = await post(
    `/api/routebooks/${id}/status`,
    { expectedVersion: 5, publishStatus: 'pending_review', opsNote: '道路长期无法核验，先下线复查' },
    true
  );
  assert.equal(unpublished.status, 200, JSON.stringify(unpublished.data));
  assert.equal(unpublished.data.routebook.publishStatus, 'pending_review');
  assert.equal(unpublished.data.routebook.routingWarning, null);
  const finalVersions = await fetchJson(`${server.baseUrl}/api/routebooks/${id}/versions`, { headers: adminHeaders() });
  const unpublishAudit = finalVersions.data.audits.filter((item) => item.event === 'status-changed').at(-1);
  assert.equal(unpublishAudit.opsNote, '道路长期无法核验，先下线复查');
  assert.equal(unpublishAudit.previousStatus, 'published');
});

test('verified profile owner can edit and submit cross-device without a plaintext route token', async (t) => {
  const server = await startServer();
  t.after(server.stop);
  const post = (path, body, headers = {}) =>
    fetchJson(`${server.baseUrl}${path}`, { method: 'POST', headers: jsonHeaders(headers), body: JSON.stringify(body) });
  const registration = await post('/api/profile', { creatorName: '道路测试用户' });
  assert.equal(registration.status, 200, JSON.stringify(registration.data));
  const profile = registration.data.profile;
  const headers = { 'x-routebook-profile-id': profile.id, 'x-routebook-profile-token': profile.profileAccessToken };
  const draft = await post(
    '/api/routebooks',
    {
      profileId: profile.id,
      city: '杭州',
      stops: [
        { id: 's1', day: 'Day 1', name: '断桥残雪', lat: 30.2588, lng: 120.1525 },
        { id: 's2', day: 'Day 1', name: '平湖秋月', lat: 30.2525, lng: 120.1441 }
      ]
    },
    headers
  );
  assert.equal(draft.status, 200, JSON.stringify(draft.data));
  const id = draft.data.routebook.id;
  const detail = await fetchJson(`${server.baseUrl}/api/routebooks/${id}`, { headers });
  assert.equal(detail.data.routebook.editToken, undefined);
  assert.equal(detail.data.routebook.ownerAccessVerified, true);
  const updated = await post('/api/routebooks', { ...detail.data.routebook, title: '跨设备修改', expectedVersion: 1 }, headers);
  assert.equal(updated.status, 200, JSON.stringify(updated.data));
  assert.equal(updated.data.routebook.ownerAccessVerified, true);
  const forged = await post('/api/routebooks', {
    ...updated.data.routebook,
    profileId: 'anonymous',
    ownerAccessVerified: true,
    verifiedProfileId: profile.id,
    expectedVersion: 2
  });
  assert.equal(forged.status, 403);
  const wrongProfile = await post('/api/profile', { creatorName: '其他用户' });
  const denied = await post(
    `/api/routebooks/${id}/publish`,
    { profileId: wrongProfile.data.profile.id, expectedVersion: 2 },
    { 'x-routebook-profile-id': wrongProfile.data.profile.id, 'x-routebook-profile-token': wrongProfile.data.profile.profileAccessToken }
  );
  assert.equal(denied.status, 403);
  const submitted = await post(`/api/routebooks/${id}/publish`, { profileId: profile.id, expectedVersion: 2 }, headers);
  assert.equal(submitted.status, 200, JSON.stringify(submitted.data));
  assert.equal(submitted.data.routebook.publishStatus, 'pending_review');
});

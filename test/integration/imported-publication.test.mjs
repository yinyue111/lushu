import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adminHeaders, fetchJson, jsonHeaders, startServer } from '../helpers/server.mjs';

const STOPS = [
  { id: 's1', day: 'Day 1', name: '断桥残雪', lat: 30.2588, lng: 120.1525 },
  { id: 's2', day: 'Day 1', name: '平湖秋月', lat: 30.2525, lng: 120.1441 }
];

/** @param {{ baseUrl: string }} server */
function client(server) {
  return {
    /** @param {string} path @param {any} body @param {Record<string, string>} [headers] @param {string} [method] */
    send: (path, body, headers = {}, method = 'POST') =>
      fetchJson(`${server.baseUrl}${path}`, { method, headers: jsonHeaders(headers), body: JSON.stringify(body) }),
    /** @param {string} path @param {Record<string, string>} [headers] */
    get: (path, headers = {}) => fetchJson(`${server.baseUrl}${path}`, { headers })
  };
}

test('imported (OCR/link) routebooks are private or friend-link only, with an explained policy', async (t) => {
  const server = await startServer();
  t.after(server.stop);
  const { send, get } = client(server);
  const draft = await send('/api/routebooks', { city: '杭州', title: '截图导入的西湖路线', guideOrigins: ['ocr'], stops: STOPS });
  assert.equal(draft.status, 200, JSON.stringify(draft.data));
  const id = draft.data.routebook.publicId;
  const editToken = draft.data.routebook.editToken;
  assert.deepEqual(draft.data.routebook.guideOrigins, ['ocr']);
  assert.equal(draft.data.routebook.publication.imported, true);
  assert.equal(draft.data.routebook.publication.publicAllowed, false);
  assert.equal(draft.data.routebook.publication.canClaimAuthorship, true);
  assert.match(draft.data.routebook.publication.reason, /原作者/);

  // Provenance is sticky and friend-link keys are never accepted from a client save.
  const resaved = await send('/api/routebooks', {
    ...draft.data.routebook,
    guideOrigins: [],
    friendLink: { key: 'a'.repeat(32), createdAt: 'x' },
    expectedVersion: 1
  });
  assert.equal(resaved.status, 200, JSON.stringify(resaved.data));
  assert.deepEqual(resaved.data.routebook.guideOrigins, ['ocr']);
  assert.equal(resaved.data.routebook.friendLink, null);

  const blocked = await send(`/api/routebooks/${id}/publish`, { editToken, expectedVersion: 2 });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.code, 'IMPORTED_ROUTEBOOK_PUBLIC_DISABLED');
  assert.match(blocked.data.error, /原作者授权/);
  assert.equal(blocked.data.details.canClaimAuthorship, true);

  // Friend link: owner only, server-generated key, unlisted + noindex.
  assert.equal((await send(`/api/routebooks/${id}/friend-link`, { expectedVersion: 2 })).status, 403);
  const friend = await send(`/api/routebooks/${id}/friend-link`, { editToken, expectedVersion: 2 });
  assert.equal(friend.status, 200, JSON.stringify(friend.data));
  const friendUrl = friend.data.friendShareUrl;
  assert.match(friendUrl, new RegExp(`^/share/${id}\\?k=[a-f0-9]{32}$`));
  const key = new URL(friendUrl, server.baseUrl).searchParams.get('k');
  assert.equal(friend.data.routebook.publishStatus, 'draft');
  assert.equal((await get(`/api/share/${id}`)).status, 404, 'not public without the key');
  assert.equal((await get(`/api/share/${id}?k=${'0'.repeat(32)}`)).status, 404, 'wrong key');
  const shared = await fetch(`${server.baseUrl}/api/share/${id}?k=${key}`);
  assert.equal(shared.status, 200);
  assert.match(String(shared.headers.get('x-robots-tag')), /noindex/);
  const sharedBody = await shared.json();
  assert.equal(sharedBody.routebook.visibility, 'unlisted');
  assert.equal(JSON.stringify(sharedBody).includes(key), false, 'the key never appears in the shared view');
  assert.equal(sharedBody.routebook.friendLink, undefined);
  assert.equal(sharedBody.routebook.editToken, undefined);
  const listing = await get('/api/routebooks?status=published,featured');
  assert.equal(
    listing.data.routebooks.some((item) => item.publicId === id),
    false,
    'never publicly listed'
  );
  const landing = await fetch(`${server.baseUrl}/share/${id}?k=${key}`);
  const html = await landing.text();
  assert.equal(landing.status, 200);
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  assert.match(String(landing.headers.get('x-robots-tag')), /noindex/);
  assert.equal(html.includes('rel="canonical"'), false);
  assert.equal(html.includes(key), false);
  assert.match(html, /截图导入的西湖路线/);
  assert.equal((await send(`/api/routebooks/${id}/copy`, { profileId: 'anonymous' })).status, 404);
  assert.equal((await send(`/api/routebooks/${id}/copy`, { friendKey: key })).status, 200);

  const revoked = await send(`/api/routebooks/${id}/friend-link`, { editToken, expectedVersion: 3 }, {}, 'DELETE');
  assert.equal(revoked.status, 200, JSON.stringify(revoked.data));
  assert.equal(revoked.data.friendShareUrl, '');
  assert.equal((await get(`/api/share/${id}?k=${key}`)).status, 404, 'revoked link stops working');

  // Original authors keep the authorization path: claim -> review -> ops note.
  const claimed = await send(`/api/routebooks/${id}/publish`, {
    editToken,
    expectedVersion: 4,
    claimOriginalAuthor: true,
    authorshipClaimNote: '截图是我自己的小红书笔记'
  });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.data));
  assert.equal(claimed.data.routebook.publishStatus, 'pending_review');
  assert.equal(claimed.data.routebook.authorshipClaim.claimed, true);
  const routingOverride = { allowUnverifiedRouting: true, routingOverrideReason: '测试显式人工核验例外说明' };
  const adminBlocked = await send(`/api/routebooks/${id}/status`, { expectedVersion: 5, publishStatus: 'published', ...routingOverride }, adminHeaders());
  assert.equal(adminBlocked.status, 409);
  assert.equal(adminBlocked.data.code, 'IMPORTED_ROUTEBOOK_PUBLIC_DISABLED');
  const approved = await send(
    `/api/routebooks/${id}/status`,
    { expectedVersion: 5, publishStatus: 'published', importAuthorizationNote: '已核对作者主页与截图一致', ...routingOverride },
    adminHeaders()
  );
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  const versions = await get(`/api/routebooks/${id}/versions`, adminHeaders());
  const audit = versions.data.audits.filter((item) => item.event === 'status-changed').at(-1);
  assert.equal(audit.importAuthorization.note, '已核对作者主页与截图一致');
  assert.deepEqual(audit.importAuthorization.origins, ['ocr']);
});

test('original (non-imported) routebooks keep the normal review path', async (t) => {
  const server = await startServer();
  t.after(server.stop);
  const { send } = client(server);
  const draft = await send('/api/routebooks', { city: '杭州', title: '我自己写的路线', stops: STOPS });
  assert.equal(draft.data.routebook.publication.imported, false);
  assert.equal(draft.data.routebook.publication.publicAllowed, true);
  const submitted = await send(`/api/routebooks/${draft.data.routebook.publicId}/publish`, { editToken: draft.data.routebook.editToken, expectedVersion: 1 });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.data));
  assert.equal(submitted.data.routebook.publishStatus, 'pending_review');
});

test('the imported routebook policy is configurable', async (t) => {
  const strict = await startServer({ env: { IMPORTED_ROUTEBOOK_PUBLIC_POLICY: 'unlisted-only' } });
  const legacy = await startServer({ env: { IMPORTED_ROUTEBOOK_PUBLIC_POLICY: 'authorization-required' } });
  t.after(strict.stop);
  t.after(legacy.stop);
  for (const [server, expected] of [
    [strict, 409],
    [legacy, 200]
  ]) {
    const { send } = client(/** @type {{ baseUrl: string }} */ (server));
    const draft = await send('/api/routebooks', { city: '杭州', title: '截图导入', guideOrigins: ['ocr'], stops: STOPS });
    const result = await send(`/api/routebooks/${draft.data.routebook.publicId}/publish`, {
      editToken: draft.data.routebook.editToken,
      expectedVersion: 1,
      claimOriginalAuthor: true
    });
    assert.equal(result.status, expected, JSON.stringify(result.data));
    if (expected === 409) assert.equal(result.data.details.canClaimAuthorship, false);
  }
});

test('PUBLIC_PUBLISHING=disabled keeps every routebook private or friend-link only', async (t) => {
  const server = await startServer({ env: { PUBLIC_PUBLISHING: 'disabled' } });
  t.after(server.stop);
  const { send } = client(server);
  const draft = await send('/api/routebooks', { city: '杭州', title: '我自己写的路线', stops: STOPS });
  assert.equal(draft.status, 200, JSON.stringify(draft.data));
  const { publicId, editToken, publication } = draft.data.routebook;
  assert.equal(publication.publicAllowed, false);
  assert.equal(publication.publishingDisabled, true);
  assert.equal(publication.friendLinkAllowed, true);
  const submitted = await send(`/api/routebooks/${publicId}/publish`, { editToken, expectedVersion: 1, claimOriginalAuthor: true });
  assert.equal(submitted.status, 409, JSON.stringify(submitted.data));
  assert.equal(submitted.data.code, 'PUBLIC_PUBLISHING_DISABLED');
  // Ops cannot list it either.
  const opsPublish = await send(
    `/api/routebooks/${publicId}/status`,
    { expectedVersion: 1, publishStatus: 'published', allowUnverifiedRouting: true, routingOverrideReason: '测试显式人工核验例外说明' },
    adminHeaders()
  );
  assert.equal(opsPublish.status, 409, JSON.stringify(opsPublish.data));
  assert.equal(opsPublish.data.code, 'PUBLIC_PUBLISHING_DISABLED');
});

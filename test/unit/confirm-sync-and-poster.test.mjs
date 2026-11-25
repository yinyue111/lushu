import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchJson, jsonHeaders, startServer } from '../helpers/server.mjs';
import { normalizeConfirmAcks } from '../../server/routebooks/normalize.mjs';
import { collectRouteConfirmEntries } from '../../src/lib/confirmChecklist.js';
import { createPrivateRoutebookDraft } from '../../src/lib/privateDraft.js';
import { buildPosterModel } from '../../src/lib/routePoster.js';

const STOPS = [
  {
    id: 's1',
    day: 'Day 1',
    time: '09:00',
    name: '法喜寺',
    stay: '90 分钟',
    cost: '价格待确认',
    verify: '需提前实名预约；开放时间待确认',
    lat: 30.2366,
    lng: 120.0954,
    geoConfidence: 88
  },
  {
    id: 's2',
    day: 'Day 2',
    time: '10:30',
    name: '某胡同小店',
    stay: '60 分钟',
    cost: '免费',
    verify: '',
    lat: 0,
    lng: 0,
    geoConfidence: 30
  }
];

test('normalizeConfirmAcks accepts structural stop:kind keys and drops free text or duplicates', () => {
  assert.deepEqual(normalizeConfirmAcks(['s1:reservation', 's1:reservation', 's2:position', 'evil free text', 's1:unknown', '', null]), [
    's1:reservation',
    's2:position'
  ]);
});

test('collectRouteConfirmEntries aggregates across all days and buildPosterModel respects QR privacy', () => {
  const rb = { title: '杭州两日慢游', city: '杭州', transport: '公交地铁', days: ['Day 1', 'Day 2'], stops: STOPS };
  const entries = collectRouteConfirmEntries(rb, {
    claimsForStop: (stop) => (stop.id === 's1' ? [{ field: 'price' }] : [])
  });
  assert.equal(
    entries.some((e) => e.item.key === 's1:reservation' && e.day === 'Day 1'),
    true
  );
  assert.equal(
    entries.some((e) => e.item.key === 's1:price'),
    false
  );
  assert.equal(
    entries.some((e) => e.item.key === 's2:position' && e.day === 'Day 2'),
    true
  );

  // Private draft poster without QR URL never encodes a QR matrix
  const privatePoster = buildPosterModel(rb, { qrUrl: '' });
  assert.equal(privatePoster.qrMatrix, null);
  assert.equal(privatePoster.qrUrl, '');
  assert.ok(privatePoster.highlights.length >= 2 && privatePoster.highlights.length <= 4);
  assert.match(privatePoster.highlights[0], /法喜寺.*预约/);

  // Friend-link poster encodes scannable QR matrix
  const sharedUrl = 'https://lushu.aiwuq.cn/share/rb_demo?k=0123456789abcdef0123456789abcdef';
  const friendPoster = buildPosterModel(rb, { qrUrl: sharedUrl });
  assert.equal(friendPoster.qrUrl, sharedUrl);
  assert.ok(friendPoster.qrMatrix && friendPoster.qrMatrix.size >= 29);
});

test('confirmAcks syncs for owner, exposes read-only on unlisted friend link, and never leaks to public view or copy', async (t) => {
  const server = await startServer();
  t.after(server.stop);

  const post = (path, body, headers = {}) =>
    fetchJson(`${server.baseUrl}${path}`, { method: 'POST', headers: jsonHeaders(headers), body: JSON.stringify(body) });
  const get = (path, headers = {}) => fetchJson(`${server.baseUrl}${path}`, { headers });

  const created = await post('/api/routebooks', {
    profileId: 'p_owner_1',
    city: '杭州',
    title: '同行准备测试路书',
    days: ['Day 1', 'Day 2'],
    stops: STOPS
  });
  assert.equal(created.status, 200);
  const id = created.data.routebook.publicId;
  const editToken = created.data.routebook.editToken;

  // Stranger without editToken gets 403
  const strangerAttempt = await post(`/api/routebooks/${id}/confirm-acks`, {
    profileId: 'p_stranger',
    confirmAcks: ['s1:reservation']
  });
  assert.equal(strangerAttempt.status, 403);

  // Owner updates confirmAcks (free-text junk filtered out)
  const ackRes = await post(`/api/routebooks/${id}/confirm-acks`, {
    profileId: 'p_owner_1',
    editToken,
    confirmAcks: ['s1:reservation', 'not-a-valid-key']
  });
  assert.equal(ackRes.status, 200);
  assert.deepEqual(ackRes.data.confirmAcks, ['s1:reservation']);

  // Subsequent draft save omitting confirmAcks preserves existing confirmAcks
  const resaved = await post('/api/routebooks', {
    id,
    publicId: id,
    profileId: 'p_owner_1',
    editToken,
    expectedVersion: ackRes.data.version,
    city: '杭州',
    title: '同行准备测试路书（改标题）',
    days: ['Day 1', 'Day 2'],
    stops: STOPS
  });
  assert.equal(resaved.status, 200);
  assert.deepEqual(resaved.data.routebook.confirmAcks, ['s1:reservation']);

  // Create unlisted friend link -> friend link viewer sees confirmAcks
  const friendRes = await post(`/api/routebooks/${id}/friend-link`, {
    profileId: 'p_owner_1',
    editToken,
    expectedVersion: resaved.data.routebook.version
  });
  assert.equal(friendRes.status, 200);
  const friendPath = `/api${friendRes.data.friendShareUrl}`;
  const friendView = await get(friendPath);
  assert.equal(friendView.status, 200);
  assert.equal(friendView.data.routebook.visibility, 'unlisted');
  assert.deepEqual(friendView.data.routebook.confirmAcks, ['s1:reservation']);

  // Copying into another user's private draft strips confirmAcks
  const copiedDraft = createPrivateRoutebookDraft(friendView.data.routebook, { id: 'p_companion' });
  assert.equal(/** @type {any} */ (copiedDraft).confirmAcks, undefined);

  // Public square share (curated featured route) never carries confirmAcks
  const publicShare = await get('/api/share/hz-westlake-classic');
  if (publicShare.status === 200) {
    assert.equal(publicShare.data.routebook.visibility, 'public');
    assert.equal(publicShare.data.routebook.confirmAcks, undefined);
  }
});

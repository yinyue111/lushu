import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchJson, jsonHeaders, startServer } from '../helpers/server.mjs';

test('patch apply saves to the cloud with expectedVersion and rejects a stale version', async (t) => {
  const server = await startServer();
  t.after(server.stop);
  const post = (path, body) => fetchJson(`${server.baseUrl}${path}`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(body) });
  const stops = [
    { id: 's1', day: 'Day 1', time: '09:00', name: '断桥残雪', lat: 30.2588, lng: 120.1525 },
    { id: 's2', day: 'Day 1', time: '11:00', name: '平湖秋月', lat: 30.2525, lng: 120.1441 }
  ];
  const draft = await post('/api/routebooks', { city: '杭州', title: '局部调整', stops });
  assert.equal(draft.status, 200, JSON.stringify(draft.data));
  const book = draft.data.routebook;
  const proposal = { id: 'p1', summary: '换顺序', stops: [stops[1], stops[0]] };
  const ok = await post(`/api/routebooks/${book.publicId}/patch/apply`, { editToken: book.editToken, city: '杭州', expectedVersion: book.version, proposal });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.routebook.stops[0].name, '平湖秋月');
  const stale = await post(`/api/routebooks/${book.publicId}/patch/apply`, {
    editToken: book.editToken,
    city: '杭州',
    expectedVersion: book.version,
    proposal
  });
  assert.equal(stale.status, 409);
});

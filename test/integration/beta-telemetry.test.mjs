import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adminHeaders, fetchJson, jsonHeaders, startServer } from '../helpers/server.mjs';
import { buildActivationFunnel, normalizeClientError } from '../../server/analytics/funnelEvents.mjs';

test('activation funnel counts unique people per step and first generation success from AI logs', () => {
  const at = new Date().toISOString();
  const rows = [
    { event: 'home_view', key: 'a', createdAt: at },
    { event: 'home_view', key: 'a', createdAt: at },
    { event: 'home_view', key: 'b', createdAt: at },
    { event: 'create_start', key: 'a', createdAt: at },
    { event: 'share_open', key: '', createdAt: at }
  ];
  const steps = buildActivationFunnel(rows, [{ kind: 'generate-routebook', status: 'ok', profileId: 'p1', createdAt: at }]);
  assert.deepEqual(steps.map((s) => s.count), [2, 1, 0, 1, 1]);
  assert.equal(steps[1].rateFromPrevious, 50);
});

test('client errors keep only path (no query) and truncated text', () => {
  const row = normalizeClientError({ kind: 'render', message: 'x'.repeat(900), url: '/route/abc?k=secret', stack: 'a\nb' });
  assert.equal(row.path, '/route/abc');
  assert.ok(row.message.length <= 500);
});

test('endpoints: client funnel events are whitelisted; server-only events cannot be forged; errors are logged and shown to ops', async (t) => {
  const server = await startServer();
  t.after(server.stop);
  const post = (path, body) => fetchJson(`${server.baseUrl}${path}`, { method: 'POST', headers: jsonHeaders({ origin: server.baseUrl }), body: JSON.stringify(body) });
  assert.equal((await post('/api/funnel-events', { event: 'home_view', profileId: 'abc' })).status, 200);
  assert.equal((await post('/api/funnel-events', { event: 'register_complete' })).status, 400);
  assert.equal((await post('/api/client-errors', { kind: 'render', message: 'boom', url: '/x' })).status, 200);
  const dash = await fetchJson(`${server.baseUrl}/api/dashboard`, { headers: adminHeaders() });
  assert.equal(dash.status, 200, JSON.stringify(dash.data).slice(0, 200));
  const funnel = dash.data.dashboard?.funnel ?? dash.data.funnel;
  assert.equal(funnel.activation[0].count, 1);
  assert.equal(funnel.clientErrors24h, 1);
});

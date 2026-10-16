// B5 (P0): 「这台设备上的改动和云端不一致」 must only appear when BOTH the local copy and the
// cloud copy changed since the last common sync. Root cause was in app code: offline, the
// Service Worker answered GET /api/routebooks/:id with its stale cached copy, and the page
// compared a locally edited routebook against that stale copy and called it a conflict.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import test from 'node:test';

register(
  'data:text/javascript,' +
    encodeURIComponent(
      `export async function resolve(s,c,n){try{return await n(s,c)}catch(e){if(/^\\.\\.?\\//.test(s)&&!/\\.[cm]?jsx?$/.test(s))return n(s+'.js',c);throw e}}`
    ),
  import.meta.url
);
const { routebookRefreshDecision, routebookRemoteAdvanced } = await import('../../src/components/Route/routebookModel.js');

const PROFILE = 'p_me';
const stop = (name) => ({ name, day: '第1天', time: '09:00', lat: 30.25, lng: 120.15 });
const synced = {
  publicId: 'rb_1',
  profileId: PROFILE,
  version: 3,
  updatedAt: '2026-10-16T00:00:00.000Z',
  stops: [stop('柳浪闻莺'), stop('南宋御街'), stop('北山街')]
};
// The user deleted one stop on this device after the last sync (not yet saved to the cloud).
const localEdited = { ...synced, stops: [stop('柳浪闻莺'), stop('北山街')], provider: { editedAt: '2026-10-16T00:05:00.000Z' } };

test('B5: offline stale cache of the last synced copy is not a conflict (the reported bug)', () => {
  // Before the fix this was preserveLocal=true and the page raised the conflict notice.
  const decision = routebookRefreshDecision(synced, localEdited, PROFILE, { remoteFromCache: true });
  assert.equal(decision.conflict, false);
  assert.equal(decision.remoteFromCache, true);
  assert.equal(decision.reason, 'local-dirty-offline-cache');
});

test('B5: only-local edits with an unchanged cloud copy are not a conflict even online', () => {
  const decision = routebookRefreshDecision(synced, localEdited, PROFILE);
  assert.equal(decision.preserveLocal, true, 'local edits are still kept on screen');
  assert.equal(decision.remoteAdvanced, false);
  assert.equal(decision.conflict, false);
});

test('B5: genuine two-sided change (local dirty + cloud version advanced) is a conflict', () => {
  const remoteAdvanced = { ...synced, version: 4, updatedAt: '2026-10-16T00:06:00.000Z', stops: [stop('灵隐寺')] };
  const decision = routebookRefreshDecision(remoteAdvanced, localEdited, PROFILE);
  assert.equal(decision.conflict, true);
  assert.equal(decision.reason, 'local-dirty-remote-advanced');
  // …but never from a cached (offline) copy, even if that cache happens to be newer.
  assert.equal(routebookRefreshDecision(remoteAdvanced, localEdited, PROFILE, { remoteFromCache: true }).conflict, false);
});

test('B5: cloud changed but local untouched is not a conflict (plain refresh)', () => {
  const remoteAdvanced = { ...synced, version: 4, stops: [stop('灵隐寺')] };
  assert.equal(routebookRefreshDecision(remoteAdvanced, synced, PROFILE).conflict, false);
});

test('B5: remote-advanced falls back to updatedAt when versions are missing', () => {
  const a = { updatedAt: '2026-10-16T00:00:00.000Z' };
  assert.equal(routebookRemoteAdvanced({ updatedAt: '2026-10-16T00:01:00.000Z' }, a), true);
  assert.equal(routebookRemoteAdvanced({ updatedAt: '2026-10-16T00:00:00.000Z' }, a), false);
  assert.equal(routebookRemoteAdvanced({}, a), false, 'a missing cloud copy is never divergence');
  assert.equal(routebookRemoteAdvanced({ version: 3 }, { version: 3 }), false);
});

test('B5: Service Worker tags its offline fallback so the page knows it is a stale cache', async () => {
  const sw = readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8');
  assert.match(sw, /if \(cached\) return markOfflineCache\(cached\);/);
  const fn = /function markOfflineCache\(cached\) \{[\s\S]*?\n\}/.exec(sw)?.[0];
  assert.ok(fn);
  const markOfflineCache = new Function(`${fn}; return markOfflineCache;`)();
  const tagged = markOfflineCache(new Response('{"routebook":{}}', { status: 200, headers: { 'content-type': 'application/json' } }));
  assert.equal(tagged.headers.get('x-lushu-offline-cache'), '1');
  assert.equal(tagged.status, 200);
  assert.deepEqual(await tagged.json(), { routebook: {} });
});

test('B5: api client surfaces the offline-cache flag and App skips conflict detection on it', () => {
  const api = readFileSync(new URL('../../src/lib/api.js', import.meta.url), 'utf8');
  assert.match(api, /x-lushu-offline-cache'\) === '1'\) data\.offlineCache = true/);
  const app = readFileSync(new URL('../../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /routebookRefreshDecision\(data\.routebook, latestLocal, profile\.id, \{ remoteFromCache: Boolean\(data\.offlineCache\) \}\)/);
  assert.match(app, /if \(data\.offlineCache && latestLocal\) \{/);
  assert.match(app, /if \(refreshDecision\.conflict\) \{/);
  // The notice is only raised inside the conflict branch.
  const idx = app.indexOf('if (refreshDecision.conflict) {');
  assert.ok(app.indexOf("setRoutebookRefreshNotice('两个版本都存进了「我的」") > idx);
});

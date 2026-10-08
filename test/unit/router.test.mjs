import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRouter, route } from '../../server/http/router.mjs';

const noop = () => {};
const router = createRouter([
  route('GET', '/api/map-tiles/*', noop),
  route('GET', '/api/routebooks', noop),
  route('GET', '/api/routebooks/:id/versions', noop),
  route('GET', '/api/routebooks/:id', noop),
  route('POST', '/api/routebooks/:id/status', noop)
]);
const hit = (method, path) => {
  const match = router.match(method, path);
  return match ? [match.route.pattern, match.params] : null;
};

test('exact literal routes', () => {
  assert.deepEqual(hit('GET', '/api/routebooks'), ['/api/routebooks', {}]);
  assert.equal(hit('POST', '/api/routebooks'), null);
  assert.equal(hit('GET', '/api/routebooksx'), null);
});

test(':id matches exactly one segment (path-separator regression)', () => {
  assert.deepEqual(hit('GET', '/api/routebooks/rb-hz'), ['/api/routebooks/:id', { id: 'rb-hz' }]);
  // Previously startsWith('/api/routebooks/') + sanitizePublicId turned this into "rb-hz".
  assert.equal(hit('GET', '/api/routebooks/rb/-hz'), null);
  assert.equal(hit('GET', '/api/routebooks/rb-hz/unknown'), null);
  assert.deepEqual(hit('GET', '/api/routebooks/rb-hz/versions'), ['/api/routebooks/:id/versions', { id: 'rb-hz' }]);
  assert.deepEqual(hit('POST', '/api/routebooks/a%2Fb/status'), ['/api/routebooks/:id/status', { id: 'a%2Fb' }]);
});

test('an empty trailing segment still reaches the handler (it reports the missing id itself)', () => {
  assert.deepEqual(hit('GET', '/api/routebooks/'), ['/api/routebooks/:id', { id: '' }]);
});

test('wildcard captures the remainder', () => {
  assert.deepEqual(hit('GET', '/api/map-tiles/3/1/2.png'), ['/api/map-tiles/*', { '*': '3/1/2.png' }]);
  assert.equal(hit('GET', '/api/map-tiles'), null);
});

test('method matching is case-insensitive and first match wins', () => {
  const ordered = createRouter([route('GET', '/a/:x', () => 1), route('GET', '/a/:y', () => 2)]);
  const match = ordered.match('get', '/a/1');
  assert.equal(match.route.handler(), 1);
});

test('invalid patterns are rejected', () => {
  assert.throws(() => route('GET', 'api/x', noop));
  assert.throws(() => route('GET', '/api/*/x', noop));
});

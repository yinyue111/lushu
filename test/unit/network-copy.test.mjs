import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { NETWORK_ERROR_KEPT_TEXT, NETWORK_ERROR_TEXT, isNetworkFailure, networkError } from '../../src/lib/networkCopy.js';
import { authErrorCopy } from '../../src/lib/accountCopy.js';
import { generationFailureCopy } from '../../src/lib/generationJob.js';

test('service worker offline fallback uses the same network sentence as the app', () => {
  const sw = readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8');
  assert.ok(sw.includes(`const OFFLINE_FALLBACK_TEXT = '${NETWORK_ERROR_TEXT}'`));
  // SW still never intercepts admin or generic API traffic.
  assert.match(sw, /url\.pathname === '\/admin' \|\| url\.pathname\.startsWith\('\/admin\/'\)\) return;/);
  assert.match(sw, /if \(isApiRequest\(url\)\) return;/);
});

test('a failed fetch becomes NETWORK_OFFLINE; aborts pass through', () => {
  const e = networkError(new TypeError('Failed to fetch'));
  assert.equal(e.code, 'NETWORK_OFFLINE');
  assert.equal(e.message, NETWORK_ERROR_KEPT_TEXT);
  assert.ok(isNetworkFailure(e));
  const abort = Object.assign(new Error('x'), { name: 'AbortError' });
  assert.equal(networkError(abort), abort);
  assert.equal(isNetworkFailure(abort), false);
});

test('generation and account failures say the same network sentence', () => {
  assert.equal(generationFailureCopy({ code: 'NETWORK_OFFLINE' }).detail, NETWORK_ERROR_KEPT_TEXT);
  assert.equal(authErrorCopy(new TypeError('Failed to fetch')), NETWORK_ERROR_KEPT_TEXT);
});

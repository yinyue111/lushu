import test from 'node:test';
import assert from 'node:assert/strict';
import { isLocalRequest } from '../../server/auth/request-access.mjs';

const request = (headers = {}, remoteAddress = '127.0.0.1') => ({ socket: { remoteAddress }, headers: { host: '127.0.0.1:5173', ...headers } });

test('local bypass requires both a loopback socket and local same-origin context', () => {
  assert.equal(isLocalRequest(request()), true);
  assert.equal(isLocalRequest(request({ host: 'localhost:5173', origin: 'http://localhost:5173' })), true);
  assert.equal(isLocalRequest(request({ host: '[::1]:5173' }, '::1')), true);
  assert.equal(isLocalRequest(request({ host: '127.1.2.3:5173' })), true);
  for (const headers of [
    { host: 'evil.example' },
    { host: '127.evil.example' },
    { host: 'localhost.evil.example' },
    { host: 'localhost@evil.example' },
    { host: 'localhost/path' },
    { host: '' },
    { origin: 'https://evil.example' },
    { origin: 'null' },
    { origin: 'http://127.0.0.1:9999' },
    { origin: 'http://127.0.0.1:5173/path' },
    { origin: 'http://127.0.0.1:5173', 'sec-fetch-site': 'cross-site' }
  ])
    assert.equal(isLocalRequest(request(headers)), false, JSON.stringify(headers));
  assert.equal(isLocalRequest(request({}, '10.0.0.1')), false);
});

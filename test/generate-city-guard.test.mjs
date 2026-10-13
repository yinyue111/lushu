import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizePayload } from '../server/ai/generate.mjs';

test('empty city is rejected', () => {
  assert.throws(() => sanitizePayload({ city: '', guide: '玩两天' }), (e) => e.code === 'CITY_REQUIRED' && e.statusCode === 400);
});

test('out-of-region city is rejected', () => {
  assert.throws(() => sanitizePayload({ city: '成都', guide: '玩两天' }), (e) => e.code === 'CITY_NOT_OPEN');
});

test('jzh city passes', () => {
  assert.equal(sanitizePayload({ city: '南京', guide: '玩两天' }).city, '南京');
});

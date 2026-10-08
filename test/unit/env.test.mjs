import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { envFlag, envNumber, resetEnvWarnings } from '../../server/config/env.mjs';

beforeEach(() => resetEnvWarnings());

test('envNumber: unset and blank values use the default', () => {
  assert.equal(envNumber('X', 12, { env: {} }), 12);
  assert.equal(envNumber('X', 12, { env: { X: '' } }), 12);
  assert.equal(envNumber('X', 12, { env: { X: '   ' } }), 12);
});

test('envNumber: invalid values fall back to the default and warn once (M3 regression)', () => {
  const warnings = [];
  const warn = (message) => warnings.push(message);
  // Previously Number('abc') = NaN made `count <= NaN` false → every request 429.
  assert.equal(envNumber('RATE_LIMIT_MAX', 12, { env: { RATE_LIMIT_MAX: 'abc' }, min: 1, warn }), 12);
  assert.equal(envNumber('RATE_LIMIT_MAX', 12, { env: { RATE_LIMIT_MAX: 'abc' }, min: 1, warn }), 12);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /RATE_LIMIT_MAX/);
  assert.equal(envNumber('N', 5, { env: { N: '1.5' }, warn }), 5, 'integers required by default');
  assert.equal(envNumber('N', 5, { env: { N: '1.5' }, integer: false, warn }), 1.5);
  assert.equal(envNumber('N', 5, { env: { N: 'Infinity' }, warn }), 5);
});

test('envNumber: values outside the range are clamped', () => {
  const warn = () => {};
  assert.equal(envNumber('N', 12, { env: { N: '0' }, min: 1, warn }), 1);
  assert.equal(envNumber('N', 12, { env: { N: '-5' }, min: 1, warn }), 1);
  assert.equal(envNumber('N', 12, { env: { N: '99999' }, max: 100, warn }), 100);
  assert.equal(envNumber('N', 12, { env: { N: ' 42 ' }, min: 1, warn }), 42);
});

test('envFlag only accepts literal true/false', () => {
  assert.equal(envFlag('F', false, { F: 'true' }), true);
  assert.equal(envFlag('F', false, { F: 'TRUE' }), true);
  assert.equal(envFlag('F', true, { F: 'false' }), false);
  assert.equal(envFlag('F', true, { F: 'yes' }), true);
  assert.equal(envFlag('F', false, {}), false);
});

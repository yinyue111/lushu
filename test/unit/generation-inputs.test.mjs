import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sanitizePayload } from '../../server/ai/generate.mjs';
import { parseBudgetConstraint } from '../../server/routebooks/normalize.mjs';

test('no silent "人均 900": an unset budget stays unset', () => {
  assert.equal(sanitizePayload({ city: '杭州', guide: '想去法喜寺' }).constraints.budget, '');
  assert.equal(
    sanitizePayload({ city: '杭州', guide: '想去法喜寺', constraints: { budget: '每人全程 900 元左右' } }).constraints.budget,
    '每人全程 900 元左右'
  );
});

test('builder budget labels carry scope and basis', () => {
  const trip = parseBudgetConstraint('每人全程 900 元左右');
  assert.deepEqual([trip.scope, trip.perPerson, trip.explicitScope, trip.min], ['trip', true, true, 900]);
  const daily = parseBudgetConstraint('每人每日 300 元左右');
  assert.deepEqual([daily.scope, daily.perPerson, daily.semanticsLabel], ['daily', true, '每日人均']);
  assert.equal(parseBudgetConstraint('').known, false);
});

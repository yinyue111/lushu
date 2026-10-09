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

test('F02: prompt candidates only carry facts with approved evidence inside their validity window', async () => {
  const { buildApprovedPoiPromptCandidates } = await import('../../server/ai/generate.mjs');
  const evidence = [{ id: 'ev1', url: 'https://example.com/official', capturedAt: '2026-09-01', reviewStatus: 'approved', sourceType: 'official' }];
  const base = { sourceKind: 'operational', reviewStatus: 'approved', city: '杭州', location: { lat: 30.2, lng: 120.1 }, evidence };
  const pois = [
    { ...base, name: '有效', facts: [{ field: '开放时间', value: '08:00-17:00', reviewStatus: 'approved', evidenceIds: ['ev1'], validUntil: '2027-01-01' }] },
    { ...base, name: '过期', facts: [{ field: '开放时间', value: '08:00-17:00', reviewStatus: 'approved', evidenceIds: ['ev1'], validUntil: '2026-01-01' }] },
    { ...base, name: '无证据', facts: [{ field: '开放时间', value: '08:00-17:00', reviewStatus: 'approved', evidenceIds: [], validUntil: '2027-01-01' }] },
    { ...base, name: '待审', reviewStatus: 'pending', facts: [] }
  ];
  const lines = buildApprovedPoiPromptCandidates('杭州', pois, Date.parse('2026-10-09T00:00:00Z'));
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^有效\|.*开放:08:00-17:00/);
  assert.match(lines[1], /开放:未核验/);
  assert.match(lines[2], /开放:未核验/);
});

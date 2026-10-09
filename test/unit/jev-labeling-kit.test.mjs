import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { buildLabelingKit } from '../../scripts/jev/build-labeling-kit.mjs';
import { labelDecision, scoreLabels } from '../../scripts/jev/eval-labels.mjs';
import { assertNoPersonalData } from '../../server/shadow/privacy.mjs';

test('labeling kit: ~300 items, labels blank, no personal data, committed file is current', () => {
  const items = buildLabelingKit();
  assert.ok(items.length >= 280 && items.length <= 340, String(items.length));
  assert.ok(
    items.every((item) => item.label === null),
    'labels are never pre-filled'
  );
  assert.equal(new Set(items.map((item) => item.id)).size, items.length);
  for (const item of items) assertNoPersonalData(item.state);
  assert.ok(items.filter((item) => item.task === 'import-gate').every((item) => item.synthetic === true));
  // Synthetic text never carries facts like times or prices.
  for (const item of items.filter((entry) => entry.synthetic)) {
    assert.doesNotMatch(JSON.stringify(item.state), /\d{1,2}[:：]\d{2}|元|¥|门票|营业/, item.id);
  }
  const committed = readFileSync(new URL('../../eval/jev-labeling/samples.jsonl', import.meta.url), 'utf8');
  assert.equal(committed, items.map((item) => JSON.stringify(item)).join('\n') + '\n', 'run node scripts/jev/build-labeling-kit.mjs');
});

test('eval scores only labeled items and reports order consistency', () => {
  const items = buildLabelingKit()
    .filter((item) => item.task === 'poi-duplicate')
    .slice(0, 3);
  items[0].label = { link_state: 2 };
  items[1].label = { link_state: 0 };
  const answers = new Map([
    [items[0].id, { answers: { link_state: { score: 1.9 } }, shuffledAnswers: { link_state: { score: 1.8 } } }],
    [items[1].id, { answers: { link_state: { score: 1.7 } }, shuffledAnswers: { link_state: { score: 0.2 } } }]
  ]);
  const report = scoreLabels(items, answers)['poi-duplicate'];
  assert.deepEqual([report.items, report.labeled, report.unlabeled, report.answered, report.correct], [3, 2, 1, 2, 1]);
  assert.equal(report.accuracy, 50);
  assert.equal(report.orderConsistency, 50);
  assert.equal(labelDecision('import-gate', { notes: 'unsure' }), null);
  assert.equal(labelDecision('geocode-choice', { pick: 'none_match' }), 'none_match');
});

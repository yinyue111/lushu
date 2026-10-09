import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPoiRealFeedback } from '../../src/components/Route/poiFeedbackModel.js';

test('E2E 2026-10-09: no check-ins means no "实测排队约 0 分钟 / 人均约 0 元"', () => {
  const feedback = buildPoiRealFeedback({ poiTrust: { queueMinutesMedian: null, costMedian: null, sampleCount: 0, audienceBreakdown: [] } });
  assert.equal(feedback.queueMinutes, null);
  assert.equal(feedback.costMedian, null);
  assert.equal(feedback.hasData, false);
  assert.equal(buildPoiRealFeedback({}).hasData, false);
});

test('a measured zero queue is still shown', () => {
  const feedback = buildPoiRealFeedback({ poiTrust: { queueMinutesMedian: 0, costMedian: 35.4, sampleCount: 3 } });
  assert.equal(feedback.queueMinutes, 0);
  assert.equal(feedback.costMedian, 35);
  assert.equal(feedback.hasData, true);
});

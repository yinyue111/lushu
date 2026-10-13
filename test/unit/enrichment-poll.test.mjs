import assert from 'node:assert/strict';
import { test } from 'node:test';
import { POLL_MAX_MS, POLL_START_MS, POLL_TOTAL_MS, estimateRemainingSeconds, nextPollDelay } from '../../src/lib/enrichmentPoll.js';

test('poll backoff grows to a 30 s ceiling and the total cap covers slow (8 min) checks', () => {
  let d = POLL_START_MS;
  let elapsed = 0;
  let polls = 0;
  while (elapsed < POLL_TOTAL_MS) (elapsed += d), (d = nextPollDelay(d)), (polls += 1);
  assert.equal(d, POLL_MAX_MS);
  assert.ok(POLL_TOTAL_MS >= 8 * 60 * 1000);
  assert.ok(polls < 60, `polls ${polls}`);
});

test('ETA comes only from observed progress, never invented', () => {
  assert.equal(estimateRemainingSeconds([{ at: 0, done: 0 }], { stopsTotal: 6 }), null);
  assert.equal(estimateRemainingSeconds([{ at: 0, done: 1 }, { at: 5000, done: 1 }], { stopsTotal: 6 }), null);
  assert.equal(estimateRemainingSeconds([{ at: 0, done: 1 }, { at: 60000, done: 3 }], { stopsTotal: 6 }), 90);
});

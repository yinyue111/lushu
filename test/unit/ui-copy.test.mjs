import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SEASON_NOTE, getCityStory, seasonNoteFor } from '../../src/lib/content.js';

test('F21: seasonal copy only shows inside its months', () => {
  const hangzhou = getCityStory('杭州');
  assert.match(seasonNoteFor(hangzhou, new Date(2026, 5, 15)), /梅雨季/);
  assert.equal(seasonNoteFor(hangzhou, new Date(2026, 9, 9)), DEFAULT_SEASON_NOTE);
  assert.match(seasonNoteFor(getCityStory('洛阳'), new Date(2026, 9, 9)), /AI 草稿/);
});

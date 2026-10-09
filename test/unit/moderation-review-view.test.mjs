import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('public review view withholds free text of check-ins held by moderation', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'routebook-moderation-view-'));
  process.env.ROUTEBOOK_DATA_DIR = dataDir;
  await writeFile(
    join(dataDir, 'moderation-queue.jsonl'),
    `${JSON.stringify({ type: 'moderation-item', entityType: 'checkin', entityId: 'ck-held', status: 'pending', createdAt: '2026-10-01T00:00:00Z' })}\n`
  );
  const { refreshModerationState } = await import('../../server/moderation/index.mjs');
  const { publicReviewView } = await import('../../server/routebooks/views.mjs');
  await refreshModerationState({ force: true });
  const view = publicReviewView({
    publicId: 'rv1',
    routebook: { title: 't', stops: [] },
    checkins: [
      { sourceCheckinId: 'ck-held', stopName: 'A', worth: '值得', comment: '加微信', pitfall: 'x' },
      { sourceCheckinId: 'ck-ok', stopName: 'B', worth: '值得', comment: '人不多' }
    ]
  });
  assert.equal(view.checkins[0].comment, '');
  assert.equal(view.checkins[0].textWithheld, true);
  assert.equal(view.checkins[0].worth, '值得');
  assert.equal(view.checkins[1].comment, '人不多');
});

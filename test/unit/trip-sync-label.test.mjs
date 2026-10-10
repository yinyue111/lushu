import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Prod finding: with 云端同步 off the trip bar said 「联网后自动上传」 while nothing would ever upload.
test('queued check-ins do not promise an automatic upload while 云端同步 is off', () => {
  const model = readFileSync(new URL('../../src/components/Trip/tripModel.js', import.meta.url), 'utf8');
  assert.match(model, /if \(cloudSyncOff\) return '只存在这台设备上';/);
  const view = readFileSync(new URL('../../src/components/Trip/TripView.jsx', import.meta.url), 'utf8');
  assert.match(view, /syncStatusLabel\(statusEvidence\.syncStatus, statusCheckin, \{ cloudSyncOff \}\)/);
  assert.match(view, /「我的 → 账号」开启云端同步/);
});

test('review page does not send users to a publish step that is switched off', () => {
  const review = readFileSync(new URL('../../src/components/Trip/ReviewPage.jsx', import.meta.url), 'utf8');
  assert.match(review, /publication\?\.publishingDisabled/);
  assert.match(review, /暂不开放公开发布/);
});

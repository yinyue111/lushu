import { test } from 'node:test';
import assert from 'node:assert/strict';
import { offlineBannerText, routebookUpdatedAt } from '../../src/lib/offlineBanner.js';

test('offline banner uses the newest routebook timestamp in Beijing time', () => {
  const rb = { createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-12T06:05:00Z', provider: { generatedAt: '2026-10-02T00:00:00Z' } };
  assert.equal(routebookUpdatedAt(rb)?.toISOString(), '2026-10-12T06:05:00.000Z');
  assert.equal(offlineBannerText(rb), '离线查看，信息更新于10月12日 14:05');
});

test('offline banner never invents a time', () => {
  assert.equal(offlineBannerText({}), '离线查看，信息更新时间未知');
  assert.equal(offlineBannerText({ updatedAt: 'garbage' }), '离线查看，信息更新时间未知');
});

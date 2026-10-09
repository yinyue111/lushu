import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recheckSummaryText } from '../../src/lib/recheck.js';

test('re-check summary is plain Chinese', () => {
  assert.equal(
    recheckSummaryText({ geocoded: ['新换的面馆'], unresolved: [], geocodingConfigured: true, routing: { verifiedLegs: 2, expectedLegs: 2 } }),
    '已重新定位 1 个站点（新换的面馆）；道路 2/2 段已核验。'
  );
  assert.match(
    recheckSummaryText({ geocoded: [], unresolved: ['某小店'], geocodingConfigured: true, routing: { verifiedLegs: 1, expectedLegs: 2 } }),
    /某小店 没找到准确位置/
  );
  assert.match(recheckSummaryText(null, Object.assign(new Error('x'), { status: 429 })), /太频繁/);
});

test('recheck summary explains when road verification is not configured', () => {
  const text = recheckSummaryText({ geocoded: [], unresolved: [], routingConfigured: false, routing: { expectedLegs: 6, verifiedLegs: 0 } });
  assert.match(text, /道路核验服务暂未开启/);
  assert.doesNotMatch(text, /0\/6/);
});

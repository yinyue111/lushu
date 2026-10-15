import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recheckSummaryText } from '../../src/lib/recheck.js';

test('re-check summary is plain Chinese', () => {
  assert.equal(
    recheckSummaryText({ geocoded: ['新换的面馆'], unresolved: [], geocodingConfigured: true, routing: { verifiedLegs: 2, expectedLegs: 2 } }),
    '已重新定位 1 个站点（新换的面馆）；2/2 段路线已查过。'
  );
  assert.match(
    recheckSummaryText({ geocoded: [], unresolved: ['某小店'], geocodingConfigured: true, routing: { verifiedLegs: 1, expectedLegs: 2 } }),
    /某小店 没找到准确位置/
  );
  assert.match(recheckSummaryText(null, Object.assign(new Error('x'), { status: 429 })), /太频繁/);
});

test('recheck summary explains when road verification is not configured', () => {
  const text = recheckSummaryText({ geocoded: [], unresolved: [], routingConfigured: false, routing: { expectedLegs: 6, verifiedLegs: 0 } });
  assert.match(text, /查路线的功能还没开/);
  assert.doesNotMatch(text, /0\/6/);
});

test('empty success uses 核对 wording', () => {
  assert.equal(recheckSummaryText({ geocoded: [], unresolved: [], routing: {} }), '核对完成，没有需要重新定位的站点。');
  assert.match(recheckSummaryText(null, Object.assign(new Error('x'), { status: 429 })), /核对太频繁/);
  assert.match(recheckSummaryText(null, Object.assign(new Error('x'), { code: 'ROUTEBOOK_RECHECK_DRAFT_ONLY' })), /重新核对道路/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { pageHasSeasonalPrice } from '../server/enrich/engine.mjs';

test('seasonal price near place name is detected', () => {
  assert.equal(pageHasSeasonalPrice('拙政园 夏令时 07:30-17:30 淡季票价：70元|旺季票价：80元', '拙政园'), true);
  assert.equal(pageHasSeasonalPrice('鸡鸣寺 门票价格：10元/人', '鸡鸣寺'), false);
});

import { extractConditions } from '../server/enrich/engine.mjs';

test('conditions are quoted verbatim from the page near the place name', () => {
  const lingyin = '自2025年12月1日起，灵隐寺免票，游客通过小程序实名预约。';
  const c = extractConditions(lingyin, '灵隐寺');
  assert.equal(c[0].kind, 'reservation');
  assert.ok(lingyin.includes(c[0].quote));
  const fzm = extractConditions('夫子庙景区全天免费开放，大成殿另收费，门票15元。', '夫子庙');
  assert.deepEqual(
    fzm.map((x) => x.kind),
    ['extra-charge']
  );
  const zzy = extractConditions('拙政园 淡季票价：70元|旺季票价：80元', '拙政园');
  assert.equal(zzy[0].kind, 'seasonal');
  assert.deepEqual(extractConditions('鸡鸣寺 门票10元', '鸡鸣寺'), []);
  // not near the name → nothing
  assert.deepEqual(extractConditions(`鸡鸣寺${'。'.repeat(400)}需预约`, '鸡鸣寺'), []);
});

test('a condition about another place in the neighbourhood is not attached', () => {
  assert.deepEqual(extractConditions('鸡鸣寺门票10元。南京博物院需提前预约，建议预留3小时。', '鸡鸣寺'), []);
  assert.deepEqual(extractConditions('拙政园开放时间7:30-17:30。寒山寺免费,需要预约。', '拙政园'), []);
});

test('a sentence comparing other places to this one is skipped', () => {
  assert.deepEqual(extractConditions('老门东、总统府等景点与夫子庙独立售票，需单独购票。', '夫子庙'), []);
});

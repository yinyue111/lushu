import test from 'node:test';
import assert from 'node:assert/strict';
import { pageHasSeasonalPrice } from '../server/enrich/engine.mjs';

test('seasonal price near place name is detected', () => {
  assert.equal(pageHasSeasonalPrice('拙政园 夏令时 07:30-17:30 淡季票价：70元|旺季票价：80元', '拙政园'), true);
  assert.equal(pageHasSeasonalPrice('鸡鸣寺 门票价格：10元/人', '鸡鸣寺'), false);
});

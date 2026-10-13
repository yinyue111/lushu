import assert from 'node:assert/strict';
import { test } from 'node:test';
import { costDisplay, unifyPendingWording } from '../../src/lib/cost.js';
import { guardRoutebookFacts } from '../../server/ai/factGuard.mjs';

test('model-written 免费 shows 价格待确认 with an AI note, never as verified', () => {
  const d = costDisplay({ cost: '免费', costInfo: { free: true, known: true, source: 'model', text: '免费' } });
  assert.equal(d.text, '价格待确认');
  assert.equal(d.pending, true);
  assert.match(d.aiNote, /AI 写的「免费」/);
});

test('guide-backed and user prices are shown as written', () => {
  assert.equal(costDisplay({ cost: '免费', costInfo: { free: true, known: true, source: 'model', basis: 'guide', text: '免费' } }).text, '免费');
  assert.equal(costDisplay({ cost: '80 元', costInfo: { amount: 80, known: true, source: 'user', text: '80 元' } }).text, '80 元');
});

test('pending wording is unified to 待确认', () => {
  assert.equal(unifyPendingWording('门票待核实'), '门票待确认');
  assert.equal(unifyPendingWording('人均因店而异'), '人均待确认');
  assert.equal(unifyPendingWording('地址待补充，待确认'), '地址待确认');
});

test('fact guard records the price basis: 免费 not in the guide is model, in the guide is guide', () => {
  const rb = (cost) => ({ stops: [{ name: '断桥', cost, costInfo: { free: true, known: true, source: 'model', text: cost } }] });
  assert.equal(guardRoutebookFacts(rb('免费'), { guide: '断桥 看日落' }).routebook.stops[0].costInfo.basis, 'model');
  assert.equal(guardRoutebookFacts(rb('免费'), { guide: '断桥免费，看日落' }).routebook.stops[0].costInfo.basis, 'guide');
});

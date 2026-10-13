import test from 'node:test';
import assert from 'node:assert/strict';
import { factPresentation } from '../../src/lib/factPresentation.js';
import { lastAttemptText } from '../../src/lib/generationJob.js';

const src = (n) => Array.from({ length: n }, (_, i) => ({ url: `https://e.org/${i}` }));

test('unreported values keep their verification mark', () => {
  assert.equal(factPresentation({ method: 'ops-verified', display: '门票：30 元 · 人工核实 · 2026-10-13', sources: src(1) }).label, '人工核实');
  assert.equal(factPresentation({ method: 'auto', display: '门票：30 元', sources: src(2) }).label, '已核对');
});

test('reported operator-verified value shows only the review state, with a truthful note', () => {
  const view = factPresentation({ method: 'ops-verified', reported: true, display: '开放时间：09:00-17:00 · 人工核实 · 2026-10-13', sources: src(1) });
  assert.equal(view.label, '');
  assert.doesNotMatch(view.display, /人工核实/);
  assert.equal(view.display, '开放时间：09:00-17:00 · 2026-10-13');
  assert.equal(view.reviewNote, '当前显示的是上次人工核实的值');
});

test('reported automatic values say where the value came from', () => {
  assert.equal(factPresentation({ reported: true, display: 'x', sources: src(3) }).reviewNote, '当前显示的是自动核对的值（3 个来源一致）');
  assert.equal(factPresentation({ reported: true, display: 'x', sources: src(1) }).reviewNote, '当前显示的是自动查到的值（只有 1 个来源）');
  assert.equal(factPresentation({ reported: true, display: 'x', sources: src(1) }).label, '');
});

test('last attempt time comes only from the job timestamp', () => {
  assert.equal(lastAttemptText(''), '');
  assert.equal(lastAttemptText(undefined), '');
  assert.equal(lastAttemptText('not a date'), '');
  const iso = '2026-10-13T16:41:00.000Z';
  const d = new Date(iso);
  assert.equal(
    lastAttemptText(iso),
    `最后一次尝试：${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  );
});

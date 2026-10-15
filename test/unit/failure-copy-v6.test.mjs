import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { generationFailureCopy, retryHintText } from '../../src/lib/generationJob.js';

test('V-U6: bad model output reads as a plain failure that keeps the user input', () => {
  for (const code of ['MODEL_BAD_OUTPUT', 'MODEL_OUTPUT_TRUNCATED', 'MODEL_OUTPUT_INCOMPLETE']) {
    const copy = generationFailureCopy({ code });
    assert.equal(copy.title, '这次没排出来');
    assert.match(copy.detail, /你填的都还在/);
    assert.doesNotMatch(copy.title + copy.detail, /AI 返回|格式/);
  }
});

test('V-U5: retry hint matches the buttons (no 「稍后用轻快」 next to an immediate retry)', () => {
  assert.equal(retryHintText({ suggestDeep: true }, 'fast'), '可以马上再试一次，或者换「细品」慢慢排（大约 2–3 分钟）。');
  assert.equal(retryHintText({}, 'fast'), '可以马上再试一次。');
  const src = readFileSync(new URL('../../src/components/Builder/GenerationProgress.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /稍后用「轻快」再试/);
  // v4 rule kept: when 轻快 was already tried automatically, 「稍后再试」 stays primary.
  assert.match(src, /fallbackTriedFast \? \([\s\S]*?variant="primary" size="sm" onClick=\{onBackToPrefs\}>\s*<Clock \/> 稍后再试/);
  // the failed title is announced once (by the alert), not also by the status line.
  assert.match(src, /outcome === 'failed'\s*\?\s*''/);
});

test('V-U6: one-place hint is advisory only', () => {
  const src = readFileSync(new URL('../../src/components/Builder/BuilderSteps.jsx', import.meta.url), 'utf8');
  assert.match(src, /\(includedCount === 1 \|\| \(includedCount === 0 && candidatePlaces\.length === 1\)\) && \(\s*<p[^>]*data-testid="single-place-hint"/);
});

test('V-U13: delete toast offers undo, pauses on hover/focus and never grabs focus', () => {
  const toast = readFileSync(new URL('../../src/components/ui/toast.jsx', import.meta.url), 'utf8');
  assert.match(toast, /aria-live="polite"/);
  assert.match(toast, /onMouseEnter=\{\(\) => setPaused\(true\)\}/);
  assert.match(toast, /onFocus=\{\(\) => setPaused\(true\)\}/);
  assert.doesNotMatch(toast, /\.focus\(/);
  const view = readFileSync(new URL('../../src/components/Route/RouteView.jsx', import.meta.url), 'utf8');
  assert.match(view, /已删掉「\$\{deletedStop\.name\}」/);
  assert.match(view, /duration=\{8000\}/);
  assert.match(view, /onUndo=\{actions\.undoEdit\}/);
});

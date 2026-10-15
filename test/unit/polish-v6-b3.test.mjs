import test from 'node:test';
import assert from 'node:assert/strict';
import { formatStayText } from '../../src/lib/routeMeta.js';
import { roadbookDocumentTitle } from '../../src/lib/useDocumentTitle.js';

test('V-U20: stay text gets a space between number and unit', () => {
  assert.equal(formatStayText('约 1.5小时'), '约 1.5 小时');
  assert.equal(formatStayText('30分钟'), '30 分钟');
});

test('V-U21: client document title uses the roadbook title', () => {
  assert.equal(roadbookDocumentTitle('西湖一日'), '西湖一日｜AI 可信路书');
});

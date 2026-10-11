import test from 'node:test';
import assert from 'node:assert/strict';
import { formatRoutebookWhen, routebookCardMeta } from '../../src/lib/routebookCardMeta.js';

test('routebookCardMeta shows time, mode badge and first stop', () => {
  const book = {
    updatedAt: new Date().toISOString(),
    provider: { mode: 'fast' },
    stops: [{ name: '西湖' }, { name: '灵隐寺' }]
  };
  const meta = routebookCardMeta(book);
  assert.match(meta, /今天|昨天|\d/);
  assert.match(meta, /轻快/);
  assert.match(meta, /首站 西湖/);
  assert.match(meta, /2 站/);
});

test('formatRoutebookWhen handles empty', () => {
  assert.equal(formatRoutebookWhen(''), '');
  assert.equal(formatRoutebookWhen(null), '');
});

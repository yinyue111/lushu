import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { creatorPageTitle } from '../../src/lib/creatorName.js';

test('creator page title never falls back to the id', () => {
  for (const legacy of [null, undefined, '', '匿名旅行者', '可信路书编辑部']) assert.equal(creatorPageTitle(legacy), '这位作者的路线');
  assert.equal(creatorPageTitle('周末小王'), '周末小王 的路线');
});

test('CreatorPage source never renders creator.id and offers the self nickname hint', () => {
  const src = readFileSync(new URL('../../src/components/Creator/CreatorPage.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /creator\.id|creator\?\.id/);
  assert.match(src, /document\.title = `\$\{creatorPageTitle\(loadedName\)\}｜AI 可信路书`/);
  assert.match(src, /isSelf && !displayName/);
  assert.match(src, /href="\/my#account"/);
  assert.match(src, /设个昵称，分享时会显示/);
});

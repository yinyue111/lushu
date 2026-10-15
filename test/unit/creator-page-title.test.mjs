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
  assert.match(src, /href="\/my#nickname"/);
  assert.match(src, /设个昵称，分享时会显示/);
  assert.match(src, /title="全部路线"/);
  assert.doesNotMatch(src, /kicker="路线合集"/);
});

test('small inline tap targets use the U16 coarse-pointer ::after enlargement', async () => {
  const { TAP_TARGET } = await import('../../src/components/ui/tap-target.js');
  assert.match(TAP_TARGET, /pointer:coarse\)\]:after:h-11/);
  assert.match(TAP_TARGET, /pointer:coarse\)\]:after:min-w-11/);
  for (const f of ['Creator/CreatorPage.jsx', 'Route/RouteHero.jsx', 'Builder/BuilderSteps.jsx']) {
    const s = readFileSync(new URL(`../../src/components/${f}`, import.meta.url), 'utf8');
    assert.match(s, /\$\{TAP_TARGET\}/, f);
  }
});

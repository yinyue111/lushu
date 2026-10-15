import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { normalizeCreator } from '../../server/routebooks/normalize.mjs';
import { normalizeUserRouteCreator } from '../../server/routebooks/mutations.mjs';
import { publicCreatorName } from '../../src/lib/creatorName.js';

test('U18: legacy placeholder bylines read as null (no migration)', () => {
  for (const legacy of ['匿名旅行者', '可信路书编辑部', '', '   ', undefined, null]) {
    assert.equal(normalizeCreator({ id: 'p_x', name: legacy }).name, null, String(legacy));
    assert.equal(publicCreatorName(legacy), null, String(legacy));
  }
  assert.equal(normalizeCreator({ id: 'p_x', name: '周末小王' }).name, '周末小王');
});

test('U18: write path no longer substitutes a default byline', () => {
  assert.equal(normalizeUserRouteCreator({ creator: { name: '可信路书编辑部' } }, 'p_abc').name, null);
  assert.equal(normalizeUserRouteCreator({ creator: {} }, 'p_abc').name, null);
  assert.equal(normalizeUserRouteCreator({ creator: { name: '小王' } }, 'p_abc').name, '小王');
});

test('U18: public views gate the byline on a real nickname; author hint links to nickname setting', () => {
  const share = readFileSync(new URL('../../src/components/Route/PublicSharePage.jsx', import.meta.url), 'utf8');
  assert.match(share, /routebook\.creator\?\.id && publicCreatorName\(routebook\.creator\?\.name\) && \(/);
  const hero = readFileSync(new URL('../../src/components/Route/RouteHero.jsx', import.meta.url), 'utf8');
  assert.match(hero, /const creatorName = isOwner \? ownLabel : nickname;/);
  assert.match(hero, /\{creatorName && \(/);
  assert.match(hero, /设个昵称，分享时会显示/);
  assert.match(hero, /href="\/my#account"/);
  assert.doesNotMatch(hero, /路书作者|匿名旅行者/);
});

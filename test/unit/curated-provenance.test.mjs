import test from 'node:test';
import assert from 'node:assert/strict';
import { getCuratedRoutebook, normalizeRoutebookForStorage } from '../../server/routebooks/normalize.mjs';
import { publicRoutebookView } from '../../server/routebooks/views.mjs';
import { curatedRoutes } from '../../src/lib/content.js';
import { costDisplay } from '../../src/lib/cost.js';

test('curated stops carry 编辑部选的点 across storage and publicRoutebookView, never 来源未记录', () => {
  const book = getCuratedRoutebook(curatedRoutes[0].id);
  assert.ok(
    book.stops.every((stop) => stop.provenance.origin === 'editorial'),
    JSON.stringify(book.stops.map((s) => s.provenance.origin))
  );
  const pub = publicRoutebookView(book);
  assert.ok(
    pub.stops.every((stop) => stop.provenance?.origin === 'editorial'),
    JSON.stringify(pub.stops.map((s) => s.provenance?.origin))
  );
  assert.equal(costDisplay(pub.stops[0]).pending, false);
  assert.equal(costDisplay(pub.stops[0]).text, '免费');
});

test('a user routebook cannot forge the editorial origin', () => {
  const saved = normalizeRoutebookForStorage({
    city: '杭州',
    stops: [
      { name: '我家楼下咖啡', day: 'Day 1', time: '10:00', lat: 30.24, lng: 120.16, provenance: { origin: 'editorial', name: '我家楼下咖啡' } },
      { name: '另一家店', day: 'Day 1', time: '12:00', lat: 30.25, lng: 120.17, provenance: { origin: 'editorial', name: '另一家店' } }
    ]
  });
  assert.ok(saved.stops.every((stop) => stop.provenance.origin !== 'editorial'));
});

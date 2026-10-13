import assert from 'node:assert/strict';
import { test } from 'node:test';
import { confirmItemsForStop, groupConfirmItems } from '../../src/lib/confirmChecklist.js';

const precise = { lat: 30.24, lng: 120.1, geoConfidence: 80 };

test('model 免费 + reservation + hours become separate one-tap items', () => {
  const items = confirmItemsForStop(
    {
      id: 's1',
      name: '灵隐寺',
      ...precise,
      cost: '免费',
      costInfo: { free: true, known: true, source: 'model', text: '免费' },
      verify: '需提前实名预约；开放时间 7:00 起，以现场为准'
    },
    { city: '杭州' }
  );
  assert.deepEqual(
    items.map((i) => i.kind),
    ['reservation', 'price', 'hours']
  );
  assert.match(items[0].detail, /预约/);
  assert.match(items[1].detail, /AI 写的「免费」/);
  for (const item of items) assert.ok(/^https:\/\/(uri\.amap\.com|www\.baidu\.com)\//.test(item.action.url));
});

test('negated reservation is not an item; generic 以现场为准 adds nothing; checked fields drop', () => {
  const items = confirmItemsForStop(
    {
      id: 's2',
      name: '鸡鸣寺',
      ...precise,
      cost: '10 元',
      costInfo: { amount: 10, known: true, source: 'user', text: '10 元' },
      verify: '赏樱不需要预约；以现场为准',
      risk: '营业时间待确认'
    },
    { city: '南京', checked: { hours: true } }
  );
  assert.deepEqual(items, []);
});

test('unfound POI gets a position item with an AMap name search', () => {
  const items = confirmItemsForStop({ id: 's3', name: '某小店', lat: 0, lng: 0, cost: '人均因店而异' }, { city: '苏州' });
  assert.equal(items[0].kind, 'position');
  assert.match(items[0].action.url, /uri\.amap\.com\/search/);
  const groups = groupConfirmItems(items.map((item) => ({ item })));
  assert.deepEqual(
    groups.map((g) => g.label),
    ['门票 / 价格', '位置']
  );
});

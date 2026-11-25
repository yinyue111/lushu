import assert from 'node:assert/strict';
import test from 'node:test';
import { publicRoutebookView } from '../../server/routebooks/views.mjs';

test('§3 term-copy-dynamic: public view strips detail, enforces 9-id whitelist, and rewrites label/state terms', () => {
  const pub = publicRoutebookView({
    id: 'rb-term-dynamic',
    publicId: 'rb-term-dynamic',
    title: '杭州一日',
    city: '杭州',
    publishStatus: 'published',
    constraints: {
      budget: '人均 3876 元',
      mustGo: '秘密点玄武斋',
      avoid: '前任楼下咖啡',
      transport: '公交地铁 + 步行'
    },
    days: ['Day 1'],
    stops: [{ id: 1, day: 'Day 1', time: '09:00', name: '柳浪闻莺', verify: '待验证信息', risk: '未核验时段' }],
    validations: [
      { id: 'edit-routing', label: '路线', state: '无需核验', detail: '保存后没有同日相邻转场。' },
      { id: 'edit-budget', label: '预算风险', state: '可控', detail: '全程人均预算 3876 元' },
      { id: 'edit-constraints', label: '必去与避开', state: '未完全满足', detail: '必去未找到：秘密点玄武斋。1 个避开项。' },
      { id: 'model-custom', label: '拥挤校验', state: '通过', detail: '模型自写' }
    ],
    metrics: [{ label: '资料核验分', value: '待验证' }]
  });

  assert.deepEqual(pub.validations, [{ id: 'edit-routing', label: '路线', state: '无需核对' }]);
  assert.equal(Object.hasOwn(pub.validations[0], 'detail'), false);
  assert.equal(Object.hasOwn(pub, 'constraints'), false);
  assert.equal(pub.transport, '公交地铁 + 步行');
  assert.equal(pub.stops[0].verify, '待核对信息');
  assert.equal(pub.stops[0].risk, '未核对时段');
  assert.deepEqual(pub.metrics, [{ label: '资料核对分', value: '待核对' }]);
});

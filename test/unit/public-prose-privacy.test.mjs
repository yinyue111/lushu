import assert from 'node:assert/strict';
import test from 'node:test';
import { modernOwnerRoutebookCopy, redactPrivatePreferenceProse } from '../../server/lib/termCopy.mjs';
import { publicRoutebookView } from '../../server/routebooks/views.mjs';
import { createPrivateRoutebookDraft } from '../../src/lib/privateDraft.js';
import { sortValidationsByPriority, summarizeValidationCounts, validationStateTone } from '../../src/lib/validationCopy.js';

test('redactPrivatePreferenceProse strips private budget/mustGo/avoid clauses while keeping scenic and peak-hour tips', () => {
  const context = {
    constraints: {
      budget: '每人全程 500 元内',
      mustGo: '柳浪闻莺、私藏玄武茶寮',
      avoid: '前同事网红馆、商业步行街'
    },
    stopNames: ['柳浪闻莺', '法喜寺']
  };

  assert.equal(
    redactPrivatePreferenceProse('第一天从柳浪闻莺散步到茶山。全程控制在 500 元以内，已避开前同事网红馆。', context),
    '第一天从柳浪闻莺散步到茶山。'
  );
  assert.equal(
    redactPrivatePreferenceProse('旺季门票 80 元，建议提早到场避开周末高峰人流。必去未找到：私藏玄武茶寮。', context),
    '旺季门票 80 元，建议提早到场避开周末高峰人流。'
  );
  assert.equal(redactPrivatePreferenceProse('私藏玄武茶寮因缺少公开坐标暂未纳入；出发前请确认寺院开放时间。', context), '出发前请确认寺院开放时间。');
});

test('publicRoutebookView and createPrivateRoutebookDraft redact preference prose while owner view keeps full text', () => {
  const stored = {
    id: 'rb_prose_priv',
    publicId: 'rb_prose_priv',
    publishStatus: 'published',
    title: '杭州两日漫步',
    summary: '第一天环西湖散步，第二天走访古寺。全程人均预算 4912 元，不去前同事网红馆。',
    city: '杭州',
    transport: '公交地铁 + 步行',
    constraints: {
      transport: '公交地铁 + 步行',
      budget: '人均 4912 元',
      mustGo: '柳浪闻莺、秘密竹林茶室',
      avoid: '前同事网红馆'
    },
    days: ['Day 1', 'Day 2'],
    stops: [
      {
        id: 's1',
        day: 'Day 1',
        time: '09:30',
        name: '柳浪闻莺',
        stay: '60 分钟',
        cost: '免费',
        verify: '按用户的必去要求优先排入；免费开放无需预约。',
        risk: '秘密竹林茶室未查到位置。周末树荫段游客较多。',
        facts: [
          { id: 'fact-risk', field: '风险', value: '秘密竹林茶室未查到位置。周末树荫段游客较多。', status: '需复核' },
          { id: 'fact-priv', field: '备注', value: '全程人均预算 4912 元', status: '待核对' }
        ]
      }
    ],
    validations: [{ id: 'edit-geo', label: '定位可信', state: '通过', detail: '预算 4912 元' }],
    variants: [
      {
        id: 'v1',
        mode: '雨天',
        label: '雨天备选',
        summary: '改走室内茶馆。预算仍控制在 4912 元以内。',
        days: ['Day 1'],
        stops: [{ id: 's1', day: 'Day 1', time: '09:30', name: '柳浪闻莺', verify: '避开前同事网红馆；雨天备伞。', risk: '' }]
      }
    ]
  };

  const owner = modernOwnerRoutebookCopy(stored);
  assert.match(owner.summary, /4912/);
  assert.match(owner.stops[0].verify, /必去/);

  const pub = publicRoutebookView(stored);
  assert.equal(pub.summary, '第一天环西湖散步，第二天走访古寺。');
  assert.equal(pub.stops[0].verify, '免费开放无需预约。');
  assert.equal(pub.stops[0].risk, '周末树荫段游客较多。');
  assert.equal(pub.variants[0].summary, '改走室内茶馆。');
  assert.equal(pub.variants[0].stops[0].verify, '雨天备伞。');
  assert.equal(/4912|秘密竹林茶室|前同事网红馆|必去/.test(JSON.stringify(pub)), false);

  const draft = createPrivateRoutebookDraft(stored, { id: 'prof_other', creatorName: '路人' });
  assert.equal(draft.summary, '第一天环西湖散步，第二天走访古寺。');
  assert.equal(draft.stops[0].verify, '免费开放无需预约。');
  assert.equal(draft.stops[0].risk, '周末树荫段游客较多。');
  assert.equal(draft.variants[0].summary, '改走室内茶馆。');
  assert.equal(draft.variants[0].stops[0].verify, '雨天备伞。');
  assert.equal(/4912|秘密竹林茶室|前同事网红馆|必去/.test(JSON.stringify(draft)), false);
});

test('sortValidationsByPriority surfaces warnings above passed and supplementary rows cleanly', () => {
  const rows = [
    { id: 'day-count-compressed', label: '行程天数', state: '已压缩' },
    { id: 'edit-geo', label: '定位可信', state: '通过' },
    { id: 'edit-hours', label: '营业时间', state: '未核对' },
    { id: 'edit-tempo', label: '节奏密度', state: '偏紧' },
    { id: 'edit-routing', label: '路线', state: '已查过' }
  ];
  const sorted = sortValidationsByPriority(rows);
  assert.deepEqual(
    sorted.map((item) => item.id),
    ['edit-hours', 'edit-tempo', 'edit-geo', 'edit-routing', 'day-count-compressed']
  );
  assert.deepEqual(summarizeValidationCounts(sorted), { warnCount: 2, okCount: 2, skyCount: 1 });
  assert.equal(validationStateTone('无预算约束'), 'sky');
  assert.equal(validationStateTone('未设置'), 'sky');
});

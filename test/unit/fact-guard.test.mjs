import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildEvidence, extractClaims, guardRoutebookFacts, guardText } from '../../server/ai/factGuard.mjs';

const guide = '杭州一日：上午西湖断桥、白堤散步，中午知味观吃小笼，下午灵隐寺，傍晚河坊街。';
const evidence = buildEvidence({ guide });
const run = (text, options = {}) => {
  const events = [];
  return { text: guardText(text, evidence, { field: 'f', events, ...options }), events };
};

test('extracts addresses, prices, hours, phones, dates and branch qualifiers', () => {
  const kinds = extractClaims('仁和路83号老字号总店；门票45元；营业时间 9:00-21:00；电话 0571-87065871；10月1日起；¥120/人；知味观（湖滨店）').map(
    (c) => c.kind
  );
  for (const kind of ['address', 'branch', 'price', 'hours', 'phone', 'date']) assert.ok(kinds.includes(kind), kind);
});

test('unsupported claims become 待确认; branch qualifiers are dropped from stop names', () => {
  assert.equal(run('仁和路83号老字号总店，主打鲜肉小笼').text, '地址待确认老字号门店（待确认），主打鲜肉小笼');
  assert.equal(run('需购买飞来峰门票（45元）').text, '需购买飞来峰门票（价格待确认）');
  assert.equal(run('营业时间 09:00-21:00，电话 0571-87065871').text, '营业时间待确认，电话待确认');
  assert.equal(run('人均约 50-70 元').text, '人均价格待确认');
  assert.equal(run('知味观（湖滨总店）', { stopName: true }).text, '知味观');
  assert.equal(run('钟水饺（人民公园店/少城附近）', { stopName: true }).text, '钟水饺');
  assert.equal(run('建议 10月1日 前预约').events[0].kind, 'date');
  // A hedge in one clause does not excuse a claim in the next one.
  assert.equal(run('品牌有多家分店，本点按总店编排').text, '品牌有多家分店，本点按门店（待确认）编排');
  // Guarding is idempotent.
  const once = run('品牌有多家分店，本点按总店编排。总店靠近河坊街').text;
  assert.equal(run(once).events.length, 0);
});

test('itinerary times, hedged wording and non-branch notes are left alone', () => {
  for (const text of [
    '午市11:30至13:00客流集中',
    '分店不明：未说明哪一家店',
    '灵隐寺（飞来峰景区）',
    '门票以景区当日公示为准',
    '停留 1小时30分钟',
    '免费开放'
  ]) {
    const result = run(text, { stopName: text.startsWith('灵隐') });
    assert.equal(result.text, text, text);
    assert.equal(result.events.length, 0, text);
  }
});

test('facts present in the source, constraints or reviewed POI data are kept', () => {
  const ev = buildEvidence({
    guide: '去知味观（湖滨店）吃小笼，人均80元，电话0571-87065871',
    constraints: { budget: '人均 300 元以内' },
    poiCandidates: ['灵隐寺|坐标:30.24,120.10|开放:07:00-18:00|建议停留:2小时']
  });
  for (const text of ['知味观（湖滨店）', '人均80元', '电话 0571-87065871', '预算人均300元', '开放时间 7:00-18:00']) {
    const events = [];
    assert.equal(guardText(text, ev, { field: 'f', events, stopName: text.startsWith('知味观') }), text, text);
    assert.equal(events.length, 0, text);
  }
});

test('routebook guard rewrites every field, clears structured prices and tells the user', () => {
  const { routebook, events } = guardRoutebookFacts(
    {
      title: '杭州一日',
      summary: '湖滨总店吃小笼',
      stops: [
        {
          name: '知味观(湖滨总店)',
          time: '11:45 - 13:00',
          stay: '1小时15分钟',
          cost: '人均约 50-70 元',
          costInfo: { min: 50, max: 70, known: true, text: '人均约 50-70 元', note: '仁和路83号' },
          verify: '仁和路83号老字号总店',
          risk: '营业时间 10:00-20:30'
        }
      ],
      aiNotes: [{ label: '灵隐门票', detail: '飞来峰门票45元，香花券30元' }]
    },
    { guide }
  );
  const stop = routebook.stops[0];
  assert.equal(stop.name, '知味观');
  assert.equal(stop.time, '11:45 - 13:00', 'schedule time untouched');
  assert.equal(stop.cost, '价格待确认');
  assert.equal(stop.costInfo.min, null);
  assert.equal(stop.costInfo.known, false);
  assert.equal(stop.costInfo.note, '地址待确认');
  assert.doesNotMatch(JSON.stringify(routebook), /83号|45元|30元|50-70|10:00-20:30|总店\)/);
  assert.ok(events.length >= 7, `events: ${events.length}`);
  assert.equal(routebook.aiNotes.at(-1).label, '具体信息待确认');
});

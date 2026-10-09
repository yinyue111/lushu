import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CANDIDATE_RULES, extractPlaceCandidates, reconcileTextCandidates } from '../../src/lib/placeCandidates.js';

const names = (list) => list.map((item) => item.name);

test('F04 review example: finds 龙井, drops the preference phrase', () => {
  const found = extractPlaceCandidates('想去西湖、法喜寺、龙井，不想走太多路', { knownPlaces: ['法喜寺'] });
  assert.deepEqual(names(found).sort(), ['法喜寺', '西湖', '龙井'].sort());
  assert.ok(!names(found).some((name) => /路$/.test(name) && name.includes('走')), 'no "不想走太多路"');
});

test('confidence comes from the rule that matched, never a fixed 90', () => {
  const found = extractPlaceCandidates('想去西湖、法喜寺、龙井', { knownPlaces: ['法喜寺'] });
  const byName = Object.fromEntries(found.map((item) => [item.name, item]));
  assert.equal(byName['法喜寺'].confidence, CANDIDATE_RULES.dictionary.confidence);
  assert.equal(byName['西湖'].confidence, CANDIDATE_RULES.suffix.confidence);
  assert.equal(byName['龙井'].confidence, CANDIDATE_RULES.listed.confidence);
  assert.ok(found.every((item) => item.reason));
});

test('preference and constraint phrases are not places', () => {
  assert.deepEqual(names(extractPlaceCandidates('周末两天，带老人，少走路，别排队太久，预算有限')), []);
});

test('avoid intent is recorded, aliases collapse to the longest name', () => {
  const found = extractPlaceCandidates('避开灵隐寺，先去柳浪闻莺公园然后去南宋御街喝咖啡', { knownPlaces: ['柳浪闻莺', '柳浪闻莺公园'] });
  const byName = Object.fromEntries(found.map((item) => [item.name, item]));
  assert.equal(byName['灵隐寺'].intent, 'avoid');
  assert.ok(byName['柳浪闻莺公园']);
  assert.ok(!byName['柳浪闻莺']);
  assert.ok(byName['南宋御街']);
  assert.ok(!byName['咖啡']);
});

test('candidates are not pre-selected and disappear with their text', () => {
  let list = reconcileTextCandidates([], extractPlaceCandidates('想去西湖、法喜寺'));
  assert.ok(list.every((item) => item.included === false && item.decided === false));
  list = list.map((item) => (item.name === '西湖' ? { ...item, included: true, decided: true } : item));
  list = reconcileTextCandidates(list, extractPlaceCandidates('想去西湖'));
  assert.deepEqual(
    list.map((item) => [item.name, item.included]),
    [['西湖', true]]
  );
});

test('typing does not accumulate prefixes', () => {
  let list = [];
  for (const text of ['法喜', '法喜寺']) list = reconcileTextCandidates(list, extractPlaceCandidates(text));
  assert.deepEqual(names(list), ['法喜寺']);
});

test('candidates from other origins survive text edits', () => {
  const imported = [{ name: '武康路', origin: 'source', included: false, decided: false }];
  const list = reconcileTextCandidates(imported, extractPlaceCandidates(''));
  assert.deepEqual(names(list), ['武康路']);
});

test('real itinerary formats: day labels and dash/arrow separators (X post, 2026-04)', () => {
  // Verbatim public X post https://x.com/wang_hao541621/status/2043102263716225305 (first two days).
  const text = '成都旅游攻略\nDAY1：春熙路—IFS国金中心—大慈寺—人民公园—宽窄巷子—奎星楼街\nDAY2：熊猫基地—青羊宫—东郊记忆—建设路—武侯祠—锦里古街';
  const found = names(extractPlaceCandidates(text));
  for (const name of ['春熙路', 'IFS国金中心', '大慈寺', '人民公园', '宽窄巷子', '奎星楼街', '熊猫基地', '青羊宫', '建设路', '武侯祠', '锦里古街']) {
    assert.ok(found.includes(name), `${name} in ${found.join(',')}`);
  }
  assert.ok(!found.some((name) => /DAY|攻略/.test(name)), found.join(','));
});

test('arrow emoji, ASCII arrows and 第N天 labels split into places', () => {
  const found = names(extractPlaceCandidates('第一天：断桥残雪➡️白堤→平湖秋月 --> 雷峰塔\n第二天 灵隐寺 | 法喜寺 / 龙井村'));
  for (const name of ['断桥残雪', '白堤', '平湖秋月', '雷峰塔', '灵隐寺', '法喜寺', '龙井村']) assert.ok(found.includes(name), `${name} in ${found.join(',')}`);
});

test('spoken 抖音 transcript prose: places after motion verbs and hashtags, no particle fragments', async () => {
  const { extractPlaceCandidates } = await import('../../src/lib/placeCandidates.js');
  const text =
    '上海武康路安福路city walk路线！好逛好拍！#上海citywalk #武康大楼 #安福路\n首先乘坐地铁出发，步行几百米就能看到武康大楼同框啦！往右边这条路直行就可以到达宋庆林故居。注意哦，周一是闭馆日！顺着路走就会看到巴金故居和罗密欧阳台啦！首先推荐一家在常熟路转角口的汉堡店。';
  const names = extractPlaceCandidates(text).map((item) => item.name);
  for (const expected of ['武康大楼', '安福路', '宋庆林故居', '巴金故居', '罗密欧阳台']) assert.ok(names.includes(expected), `${expected} in ${names}`);
  for (const noise of ['注意', '好逛好', '注意哦', '顺着路走就会看到巴金故居']) assert.ok(!names.includes(noise), `${noise} not in ${names}`);
});

test('a guide pre-filled from the home page already has candidates when step 2 opens', async () => {
  const { candidatesForPrefilledGuide } = await import('../../src/lib/placeCandidates.js');
  const rows = candidatesForPrefilledGuide('西湖、法喜寺、龙井村', [], {});
  assert.deepEqual(
    rows.map((row) => [row.name, row.origin, row.included]),
    [
      ['西湖', 'guide-text', false],
      ['法喜寺', 'guide-text', false],
      ['龙井村', 'guide-text', false]
    ]
  );
  assert.deepEqual(candidatesForPrefilledGuide('   ', [{ name: 'x' }]), [{ name: 'x' }]);
});

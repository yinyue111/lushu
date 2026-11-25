import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProposalDiff, parseAdjustIntent } from '../../src/lib/adjustIntents.js';
import { proposeDayPatch } from '../../server/ai/patchRoutebook.mjs';

const CTX = {
  days: ['Day 1', 'Day 2', 'Day 3'],
  stopNames: ['法喜寺', '龙井茶园', '柳浪闻莺', '南宋御街', '浙江美术馆'],
  activeDay: 'Day 1'
};

test('parseAdjustIntent handles free L1 stop deletion, cross-day move, replacement, and mode reorders', () => {
  const remove = parseAdjustIntent('删掉法喜寺', CTX);
  assert.equal(remove?.kind, 'remove_stop');
  assert.equal(remove?.level, 'L1');
  assert.equal(remove?.params.stopName, '法喜寺');

  const move = parseAdjustIntent('把法喜寺移到第二天', CTX);
  assert.equal(move?.kind, 'move_stop_day');
  assert.equal(move?.level, 'L1');
  assert.deepEqual(move?.params, { stopName: '法喜寺', day: 'Day 2' });

  const replace = parseAdjustIntent('把南宋御街换成安静茶馆', CTX);
  assert.equal(replace?.kind, 'replace_stop');
  assert.equal(replace?.level, 'L1');
  assert.equal(replace?.params.stopName, '南宋御街');
  assert.equal(replace?.params.query, '安静茶馆');

  const walk = parseAdjustIntent('少走路', CTX);
  assert.equal(walk?.kind, 'mode_reorder');
  assert.equal(walk?.level, 'L1');
});

test('parseAdjustIntent routes natural-language requests to single-day or whole-book L2 ai_patch', () => {
  const wholeBook = parseAdjustIntent('我住龙翔桥地铁口附近，帮我把每天出发和回程排顺路，中午加一家地道杭帮菜', CTX);
  assert.equal(wholeBook?.kind, 'ai_patch');
  assert.equal(wholeBook?.level, 'L2');
  assert.equal(wholeBook?.params.scopeType, 'all');

  const singleDay = parseAdjustIntent('第二天下午太赶了，加一家湖边咖啡馆歇脚', CTX);
  assert.equal(singleDay?.kind, 'ai_patch');
  assert.equal(singleDay?.level, 'L2');
  assert.equal(singleDay?.params.scopeType, 'day');
  assert.equal(singleDay?.params.day, 'Day 2');

  const lastDay = parseAdjustIntent('最后一天下午四点半前结束行程赶高铁', CTX);
  assert.equal(lastDay?.kind, 'ai_patch');
  assert.equal(lastDay?.params.scopeType, 'day');
  assert.equal(lastDay?.params.day, 'Day 3');

  const removeAndAdd = parseAdjustIntent('不去法喜寺了，下午改成在西湖边找家安静茶馆喝茶', CTX);
  assert.equal(removeAndAdd?.kind, 'ai_patch');
  assert.equal(removeAndAdd?.level, 'L2');
});

test('proposeDayPatch supports scope.type=all across multiple days while preserving coordinates and guarding facts', async () => {
  const routebook = {
    id: 'rb-patch-all',
    city: '杭州',
    summary: '杭州两日慢游',
    days: ['Day 1', 'Day 2'],
    stops: [
      {
        id: 's-faxi',
        day: 'Day 1',
        time: '09:00',
        name: '法喜寺',
        stay: '90 分钟',
        cost: '门票 10 元',
        area: '西湖景区',
        lat: 30.2366,
        lng: 120.0954,
        geoConfidence: 88,
        coordinateSource: 'known-poi',
        coordinatePrecision: 'exact',
        navigationDisabled: false,
        provenance: { origin: 'user-guide', name: '法喜寺' }
      },
      {
        id: 's-liulang',
        day: 'Day 1',
        time: '14:00',
        name: '柳浪闻莺',
        stay: '60 分钟',
        cost: '免费',
        area: '湖滨',
        lat: 30.242,
        lng: 120.1617,
        geoConfidence: 88,
        coordinateSource: 'known-poi',
        coordinatePrecision: 'exact',
        navigationDisabled: false,
        provenance: { origin: 'user-guide', name: '柳浪闻莺' }
      },
      {
        id: 's-yujie',
        day: 'Day 2',
        time: '10:00',
        name: '南宋御街',
        stay: '90 分钟',
        cost: '免费',
        area: '上城区',
        lat: 30.2432,
        lng: 120.1696,
        geoConfidence: 88,
        coordinateSource: 'known-poi',
        coordinatePrecision: 'exact',
        navigationDisabled: false,
        provenance: { origin: 'user-guide', name: '南宋御街' }
      }
    ]
  };

  const { proposal } = await proposeDayPatch(
    routebook,
    { type: 'all', instruction: '把法喜寺移到第二天早上，第一天加茅家埠和一家神秘私房菜' },
    {
      modelCaller: async ({ isAllScope }) => {
        assert.equal(isAllScope, true);
        return {
          summary: '第一天改逛湖西茅家埠，法喜寺挪到第二天一早避开人流',
          stops: [
            { day: 'Day 1', time: '09:30', name: '柳浪闻莺', stay: '60 分钟', cost: '免费', area: '湖滨' },
            { day: 'Day 1', time: '12:00', name: '神秘私房菜馆', stay: '75 分钟', cost: '人均 388 元', area: '西湖' },
            { day: 'Day 1', time: '14:30', name: '茅家埠', stay: '90 分钟', cost: '免费', area: '西湖' },
            { day: 'Day 2', time: '08:30', name: '法喜寺', stay: '90 分钟', cost: '待确认', area: '天竺' },
            { day: 'Day 2', time: '11:30', name: '南宋御街', stay: '90 分钟', cost: '免费', area: '上城区' }
          ]
        };
      }
    }
  );

  assert.equal(proposal.scope.type, 'all');
  assert.deepEqual(proposal.days, ['Day 1', 'Day 2']);
  assert.equal(proposal.stops.length, 5);

  // Moved existing stop preserves original ID, known-poi coordinate, and verified cost ('门票 10 元')
  const movedFaxi = proposal.stops.find((s) => s.name === '法喜寺');
  assert.equal(movedFaxi?.id, 's-faxi');
  assert.equal(movedFaxi?.day, 'Day 2');
  assert.equal(movedFaxi?.cost, '门票 10 元');
  assert.equal(movedFaxi?.navigationDisabled, false);

  // Newly added catalog POI ('茅家埠') automatically resolves trusted coordinates
  const addedMaojiabu = proposal.stops.find((s) => s.name === '茅家埠');
  assert.equal(addedMaojiabu?.coordinateSource, 'known-poi');
  assert.equal(addedMaojiabu?.navigationDisabled, false);

  // Unverified fabricated price ('人均 388 元') on newly invented stop is guarded to '待确认'
  const addedRestaurant = proposal.stops.find((s) => s.name === '神秘私房菜馆');
  assert.match(String(addedRestaurant?.cost), /待确认/);
  assert.equal(addedRestaurant?.navigationDisabled, true);

  // Diff helper reports exact added/moved/removed breakdown
  const diff = buildProposalDiff(routebook.stops, proposal);
  assert.equal(diff.isAllScope, true);
  assert.equal(diff.addedCount, 2);
  assert.equal(diff.removedCount, 0);
  assert.ok(diff.movedCount >= 2);
});

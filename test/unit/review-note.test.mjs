import assert from 'node:assert/strict';
import test from 'node:test';
import { buildXiaohongshuNote, summarizeReviewJourney } from '../../src/lib/reviewNote.js';

test('buildXiaohongshuNote generates guide and vibe travelogues from real check-ins without exclamation or banned terms', () => {
  const routebook = {
    city: '杭州',
    title: '西湖南线与茶山两日漫游'
  };
  const stops = [
    { id: 's1', day: 'Day 1', time: '09:30', stay: '90 分钟', name: '柳浪闻莺', area: '西湖南线' },
    { id: 's2', day: 'Day 1', time: '11:30', stay: '90 分钟', name: '南宋御街', area: '上城' },
    { id: 's3', day: 'Day 2', time: '09:00', stay: '90 分钟', name: '法喜寺', area: '天竺山' }
  ];
  const latestByStop = new Map([
    [
      's1',
      {
        stopId: 's1',
        status: 'visited',
        worth: '值得',
        crowd: '清净',
        queue: '0 分钟',
        cost: '免费',
        comment: '早上湖风很舒服！'
      }
    ],
    [
      's2',
      {
        stopId: 's2',
        status: 'skipped',
        worth: '跳过'
      }
    ],
    [
      's3',
      {
        stopId: 's3',
        status: 'visited',
        worth: '值得',
        crowd: '适中',
        queue: '15 分钟',
        cost: '35 元',
        comment: '斋饭味道不错',
        pitfall: '周末公交等车稍久'
      }
    ]
  ]);

  const summary = summarizeReviewJourney(routebook, stops, latestByStop);
  assert.equal(summary.visitedCount, 2);
  assert.equal(summary.totalCostText, '约 35 元');
  assert.deepEqual(summary.skippedNames, ['南宋御街']);
  assert.equal(summary.pitfalls.length, 1);

  const guide = buildXiaohongshuNote(routebook, stops, latestByStop, 'guide');
  assert.equal(guide.fallbackPreview, false);
  assert.match(guide.headline, /杭州 2 天不绕路实测｜走完 2 站/);
  assert.match(guide.fullText, /柳浪闻莺/);
  assert.match(guide.fullText, /免排队/);
  assert.match(guide.fullText, /周末公交等车稍久/);
  assert.match(guide.fullText, /#杭州旅行/);
  assert.equal(/！|您|核验|校验/.test(guide.fullText), false);

  const vibe = buildXiaohongshuNote(routebook, stops, latestByStop, 'vibe');
  assert.match(vibe.headline, /最喜欢柳浪闻莺和法喜寺/);
  assert.match(vibe.fullText, /顺路动线：柳浪闻莺 → 法喜寺/);
  assert.equal(/！|您|核验|校验/.test(vibe.fullText), false);
});

test('buildXiaohongshuNote provides a clean preview draft before check-ins exist', () => {
  const routebook = { city: '苏州', title: '平江路园林一日游' };
  const stops = [
    { id: '1', day: 'Day 1', time: '09:30', name: '拙政园', cost: '80 元' },
    { id: '2', day: 'Day 1', time: '13:30', name: '平江路', cost: '免费' }
  ];
  const note = buildXiaohongshuNote(routebook, stops, new Map(), 'guide');
  assert.equal(note.fallbackPreview, true);
  assert.match(note.fullText, /拙政园/);
  assert.match(note.fullText, /#苏州一日游/);
});

test('buildXiaohongshuNote uses mid-trip wording when fewer than half of stops are checked in', () => {
  const routebook = { city: '南京', title: '博物院与秦淮两日漫游' };
  const stops = [
    { id: '1', day: 'Day 1', time: '09:30', name: '南京博物院' },
    { id: '2', day: 'Day 1', time: '14:30', name: '鸡鸣寺' },
    { id: '3', day: 'Day 2', time: '15:30', name: '老门东' },
    { id: '4', day: 'Day 2', time: '19:00', name: '夫子庙秦淮风光带' }
  ];
  const latestByStop = new Map([['1', { stopId: '1', status: 'visited', worth: '值得', queue: '10 分钟', cost: '免费' }]]);
  const guide = buildXiaohongshuNote(routebook, stops, latestByStop, 'guide');
  assert.equal(guide.isPartialProgress, true);
  assert.match(guide.headline, /已打卡 1\/4 站/);
  assert.equal(/走完/.test(guide.fullText), false);

  const vibe = buildXiaohongshuNote(routebook, stops, latestByStop, 'vibe');
  assert.equal(vibe.isPartialProgress, true);
  assert.match(vibe.fullText, /正在走这趟南京路线/);
  assert.equal(/刚走完/.test(vibe.fullText), false);
});

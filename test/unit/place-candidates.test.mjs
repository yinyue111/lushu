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

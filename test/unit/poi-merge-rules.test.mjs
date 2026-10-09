import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalPoiIdFrom, findPoiDuplicateCandidates, replayPoiMergeDecisions } from '../../server/poi/mergeRules.mjs';

const decision = (decisionType, canonicalPoiId, duplicatePoiId) => ({ type: 'poi-merge-decision', decision: decisionType, canonicalPoiId, duplicatePoiId });

test('replay applies merges, refuses chains and cycles, and unmerge reverses', () => {
  const state = replayPoiMergeDecisions([
    decision('merge', 'A', 'B'),
    decision('merge', 'C', 'A'), // A is a canonical → would chain
    decision('merge', 'B', 'A'), // cycle
    decision('merge', 'C', 'B'), // B already merged
    decision('reject', 'A', 'B'), // active merge → must unmerge first
    decision('merge', 'A', 'D')
  ]);
  assert.deepEqual([...state.redirects.entries()].sort(), [
    ['B', 'A'],
    ['D', 'A']
  ]);
  assert.equal(state.conflicts.length, 4);
  assert.equal(canonicalPoiIdFrom(state.redirects, 'B'), 'A');
  assert.equal(canonicalPoiIdFrom(state.redirects, 'Z'), 'Z');

  const undone = replayPoiMergeDecisions([decision('merge', 'A', 'B'), decision('unmerge', 'A', 'B'), decision('unmerge', 'A', 'B')]);
  assert.equal(undone.redirects.size, 0);
  assert.equal(undone.conflicts.length, 1);
  assert.equal(undone.pairs.get('A|B').decision, 'unmerge');
});

test('duplicate candidates need a name rule or near-coincident points, and skip decided pairs', () => {
  const pois = [
    { poiId: 'seed-1', city: '杭州', name: '柳浪闻莺', aliases: ['柳浪闻莺公园'], location: { lat: 30.242, lng: 120.1617 } },
    { poiId: 'op-1', city: '杭州', name: '柳浪闻莺公园', location: { lat: 30.2425, lng: 120.1619 } },
    { poiId: 'op-2', city: '杭州', name: '浙江美术馆', location: { lat: 30.2443, lng: 120.1591 } },
    { poiId: 'op-3', city: '杭州', name: '柳浪闻莺', location: { lat: 30.4, lng: 120.4 } }, // same name, far away
    { poiId: 'op-4', city: '上海', name: '柳浪闻莺', location: { lat: 31.2, lng: 121.4 } } // other city
  ];
  const candidates = findPoiDuplicateCandidates(pois);
  assert.deepEqual(
    candidates.map((candidate) => candidate.pairKey),
    ['op-1|seed-1']
  );
  assert.equal(candidates[0].nameMatch, 'alias'); // seed-1's alias equals op-1's name
  assert.ok(candidates[0].distanceMeters < 100);
  const { pairs } = replayPoiMergeDecisions([decision('reject', 'seed-1', 'op-1')]);
  assert.equal(findPoiDuplicateCandidates(pois, { pairs }).length, 0);
  const reopened = replayPoiMergeDecisions([decision('merge', 'seed-1', 'op-1'), decision('unmerge', 'seed-1', 'op-1')]);
  assert.equal(findPoiDuplicateCandidates(pois, { pairs: reopened.pairs }).length, 1);
});

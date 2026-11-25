import assert from 'node:assert/strict';
import test from 'node:test';
import { getCityStory } from '../../src/lib/content.js';
import { analyzePreTripReadiness, detectClosedWeekdays, extractReservationLeadHint, quickTripDatePresets } from '../../src/lib/preTripAdvisor.js';

test('quickTripDatePresets generates distinct future YMD options', () => {
  const clock = new Date(2026, 10, 24, 10, 0, 0); // Tue Nov 24, 2026
  const presets = quickTripDatePresets(clock);
  assert.equal(presets.length, 3);
  assert.equal(presets[0].ymd, '2026-11-25'); // Wed tomorrow
  assert.equal(presets[1].ymd, '2026-11-28'); // Sat this week
  assert.equal(presets[2].ymd, '2026-12-05'); // Sat next week
});

test('analyzePreTripReadiness detects Monday closure conflicts and suggests day swap', () => {
  const routebook = {
    city: '杭州',
    days: ['Day 1', 'Day 2'],
    constraints: { date: '2026-11-30' }, // Monday!
    stops: [
      {
        id: 's1',
        day: 'Day 1',
        name: '中国丝绸博物馆',
        verify: '周一12点前闭馆，需提前 3 天在官方公众号预约'
      },
      {
        id: 's2',
        day: 'Day 2',
        name: '柳浪闻莺',
        verify: '全天开放，无需预约'
      }
    ]
  };

  const mondayResult = analyzePreTripReadiness(routebook, { verifiedStopCount: 2, clock: new Date(2026, 10, 28, 12, 0, 0) });
  assert.equal(mondayResult.closureConflicts.length, 1);
  assert.equal(mondayResult.closureConflicts[0].stopName, '中国丝绸博物馆');
  assert.equal(mondayResult.closureConflicts[0].weekdayLabel, '周一');
  assert.equal(mondayResult.closureConflicts[0].suggestedDay, 'Day 2');
  assert.equal(mondayResult.reservationPlans.length, 1);
  assert.match(mondayResult.reservationPlans[0].hint, /距出发还有 2 天/);

  const saturdayResult = analyzePreTripReadiness(
    { ...routebook, constraints: { date: '2026-11-28' } },
    { verifiedStopCount: 2, clock: new Date(2026, 10, 24, 12, 0, 0) }
  );
  assert.equal(saturdayResult.closureConflicts.length, 0);
});

test('detectClosedWeekdays and extractReservationLeadHint respect always-open overrides and Nanjing story exists', () => {
  assert.deepEqual(detectClosedWeekdays({ name: '老门东博物馆街区', verify: '全年无休，周一正常开放' }).weekdays, []);
  assert.equal(extractReservationLeadHint({ name: '柳浪闻莺', verify: '免费开放不用预约' }), '');
  const nanjingStory = getCityStory('南京');
  assert.match(nanjingStory.kicker, /秦淮河/);
});

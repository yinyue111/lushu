import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkVisitWindow, parseOpeningHoursText, parseStayMinutes } from '../../src/lib/openingHours.js';

test('parses reviewed hours text without guessing', () => {
  assert.deepEqual(parseOpeningHoursText('08:00-17:00（16:30 停止入场），周一闭馆'), {
    alwaysOpen: false,
    openTime: '08:00',
    closeTime: '17:00',
    lastEntryTime: '16:30',
    overnight: false
  });
  assert.equal(parseOpeningHoursText('8:30—17:30，最晚入场时间 16:45').lastEntryTime, '16:45');
  assert.equal(parseOpeningHoursText('9:00-18:00').lastEntryTime, '');
  assert.equal(parseOpeningHoursText('全天开放').alwaysOpen, true);
  assert.equal(parseOpeningHoursText('周一闭馆'), null);
  assert.equal(parseOpeningHoursText(''), null);
});

test('stay text to minutes', () => {
  assert.equal(parseStayMinutes('60 分钟'), 60);
  assert.equal(parseStayMinutes('约 1.5 小时'), 90);
  assert.equal(parseStayMinutes('1-2 小时'), 120);
  assert.equal(parseStayMinutes('看情况'), null);
});

test('visit window: early, late, past last entry, overrun, ok', () => {
  const hours = parseOpeningHoursText('08:00-17:00（16:30 停止入场）');
  assert.equal(checkVisitWindow(hours, '07:30', '60 分钟').status, 'early');
  assert.equal(checkVisitWindow(hours, '16:40', '30 分钟').status, 'late');
  assert.equal(checkVisitWindow(hours, '17:10', '30 分钟').status, 'late');
  assert.equal(checkVisitWindow(hours, '16:00', '2 小时').status, 'overrun');
  assert.equal(checkVisitWindow(hours, '9:00', '2 小时').status, 'ok');
  assert.equal(checkVisitWindow(hours, '上午', '2 小时').status, 'unknown');
  assert.equal(checkVisitWindow({ alwaysOpen: true }, '', '').status, 'ok');
});

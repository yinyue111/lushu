import assert from 'node:assert/strict';
import test from 'node:test';
import { dayOptionsForMonth, daysInMonth, localYmd, parseYmd, resolveTripDate, yearForUpcomingMonth } from '../../src/lib/tripDate.js';

/** Local calendar noon so DST edges do not shift the calendar day. */
function localDate(year, month, day) {
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

const TIMEZONES = ['Asia/Shanghai', 'America/Los_Angeles'];

for (const tz of TIMEZONES) {
  test(`tripDate under ${tz}`, async (t) => {
    const prev = process.env.TZ;
    process.env.TZ = tz;
    t.after(() => {
      if (prev === undefined) delete process.env.TZ;
      else process.env.TZ = prev;
    });

    await t.test('defaults: empty stays unset', () => {
      assert.equal(parseYmd(''), null);
      assert.equal(parseYmd('   '), null);
      assert.equal(resolveTripDate(0, 1, localDate(2026, 10, 16)), null);
      assert.equal(resolveTripDate(10, 0, localDate(2026, 10, 16)), null);
    });

    await t.test('today picked = today (this year)', () => {
      const now = localDate(2026, 10, 16);
      assert.equal(resolveTripDate(10, 16, now), '2026-10-16');
      assert.deepEqual(localYmd(now), { year: 2026, month: 10, day: 16 });
    });

    await t.test('Dec 31 today picking Jan 1 = next year', () => {
      const now = localDate(2026, 12, 31);
      assert.equal(resolveTripDate(1, 1, now), '2027-01-01');
      assert.equal(yearForUpcomingMonth(1, now), 2027);
    });

    await t.test('cross-month: day after today stays this year; before today rolls year', () => {
      const now = localDate(2026, 10, 16);
      assert.equal(resolveTripDate(10, 20, now), '2026-10-20');
      assert.equal(resolveTripDate(10, 15, now), '2027-10-15');
      assert.equal(resolveTripDate(3, 1, now), '2027-03-01');
    });

    await t.test('invalid combos unavailable (Apr 31, Feb 30)', () => {
      const now = localDate(2026, 1, 15);
      assert.equal(resolveTripDate(4, 31, now), null);
      assert.equal(resolveTripDate(2, 30, now), null);
      assert.ok(!dayOptionsForMonth(4, now).includes(31));
      assert.ok(!dayOptionsForMonth(2, now).includes(30));
    });

    await t.test('Feb 29 offered only when next upcoming February is leap', () => {
      // 2027-03-01 → next Feb is 2028 (leap) → 29 offered
      const afterFeb2027 = localDate(2027, 3, 1);
      assert.equal(yearForUpcomingMonth(2, afterFeb2027), 2028);
      assert.equal(daysInMonth(2028, 2), 29);
      assert.ok(dayOptionsForMonth(2, afterFeb2027).includes(29));
      assert.equal(resolveTripDate(2, 29, afterFeb2027), '2028-02-29');

      // 2028-03-01 → next Feb is 2029 (common) → 29 not offered, never jump to 2032
      const afterFeb2028 = localDate(2028, 3, 1);
      assert.equal(yearForUpcomingMonth(2, afterFeb2028), 2029);
      assert.equal(daysInMonth(2029, 2), 28);
      assert.ok(!dayOptionsForMonth(2, afterFeb2028).includes(29));
      assert.equal(resolveTripDate(2, 29, afterFeb2028), null);

      // 2028-01-10 (leap year, before Feb) → upcoming Feb is 2028 → 29 offered
      const jan2028 = localDate(2028, 1, 10);
      assert.equal(yearForUpcomingMonth(2, jan2028), 2028);
      assert.ok(dayOptionsForMonth(2, jan2028).includes(29));
    });
  });
}

// @vitest-environment node

import { DAY_MS, GREGORIAN_START_JD, jdFromCalendar, ttFromUtcJd } from '../sky/math/time';
import {
  DEFAULT_SPEEDS,
  SIDEREAL_DAY_S,
  browserOffsetAt,
  daysInMonth,
  formatCalendar,
  formatHours,
  formatJd,
  formatOffset,
  formatSignedYear,
  gregorianNoticeForTt,
  isLeapYear,
  isUtLabel,
  localCalendarOfTt,
  nextSpeed,
  speedList,
  speedParts,
  shiftYears,
  stepTargetTt,
  stepDeltaOf,
  stepUnitsFor,
  ttFromLocalCalendar,
  ttFromUtcCalendar,
  utcCalendarOfTt,
  utcMsOfTt,
  validateFields,
  wholeSeconds,
  yearOfTt,
  zoneName,
} from './timeDisplay';
import type { CalendarFields } from './timeDisplay';

// The time display and editor helpers (TIME-1, TIME-2): calendar round trips across the whole
// ephemeris range (negative years, year 0, both DE441 bounds), the zone offset as an injected
// function (DST gap and overlap, a fixed offset, the browser's own), the readout formats, the
// field validation, the signed speed list and the step arguments.

const TT_MINUS_UTC = 69.184;
/** 2024-04-08 18:00 TT, the e2e fixture instant. */
const TT_FIXED = 2460409.25;

function fields(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): CalendarFields {
  return { year, month, day, hour, minute, second };
}

/** A Paris-like zone for 2024: UTC+1, UTC+2 between 2024-03-31T01:00Z and 2024-10-27T01:00Z. */
const DST_START_MS = Date.UTC(2024, 2, 31, 1);
const DST_END_MS = Date.UTC(2024, 9, 27, 1);
function parisLike(utcMs: number): number {
  return utcMs >= DST_START_MS && utcMs < DST_END_MS ? 120 : 60;
}

describe('UTC calendar', () => {
  it('reads the e2e fixture instant as 2024-04-08 17:58:50 UTC (TT - 69.184 s)', () => {
    const c = utcCalendarOfTt(TT_FIXED, TT_MINUS_UTC);
    expect(formatCalendar(c)).toBe('2024-04-08 17:58:50');
    expect(c.second).toBeCloseTo(50.816, 3);
    expect(utcMsOfTt(TT_FIXED, TT_MINUS_UTC)).toBeCloseTo(Date.UTC(2024, 3, 8, 17, 58, 50, 816), 0);
  });

  it.each([
    ['-0044-03-15 12:00', fields(-44, 3, 15, 12)],
    ['0000-01-01 00:00', fields(0, 1, 1)],
    ['-13200-01-01 00:00', fields(-13200, 1, 1)],
    ['17191-12-31 23:59', fields(17191, 12, 31, 23, 59, 59)],
    ['1582-10-15 00:00', fields(1582, 10, 15)],
    ['2024-02-29 06:30', fields(2024, 2, 29, 6, 30, 15)],
  ])('round-trips %s through ttFromUtcCalendar and utcCalendarOfTt', (_, f) => {
    const tt = ttFromUtcCalendar(f, TT_MINUS_UTC);
    const back = utcCalendarOfTt(tt, TT_MINUS_UTC);
    expect([back.year, back.month, back.day, back.hour, back.minute]).toEqual([
      f.year,
      f.month,
      f.day,
      f.hour,
      f.minute,
    ]);
    expect(back.second).toBeCloseTo(f.second, 3);
  });

  it('agrees with the calendar module on a Julian Date', () => {
    const tt = ttFromUtcCalendar(fields(-44, 3, 15, 12), TT_MINUS_UTC);
    expect(tt).toBeCloseTo(ttFromUtcJd(jdFromCalendar(-44, 3, 15, 12), TT_MINUS_UTC), 9);
  });
});

describe('local calendar', () => {
  it('applies a fixed offset in both directions', () => {
    const offsetAt = (): number => 120;
    const local = localCalendarOfTt(TT_FIXED, TT_MINUS_UTC, offsetAt);
    expect(formatCalendar(local.fields)).toBe('2024-04-08 19:58:50');
    expect(local.offsetMin).toBe(120);
    const back = ttFromLocalCalendar(local.fields, TT_MINUS_UTC, offsetAt);
    expect(back).toBeCloseTo(TT_FIXED, 9);
  });

  it('handles a negative offset and a negative year', () => {
    const offsetAt = (): number => -296;
    const f = fields(-44, 3, 15, 12);
    const tt = ttFromLocalCalendar(f, TT_MINUS_UTC, offsetAt);
    const utc = utcCalendarOfTt(tt, TT_MINUS_UTC);
    expect(formatCalendar(utc)).toBe('-0044-03-15 16:56:00');
    expect(formatCalendar(localCalendarOfTt(tt, TT_MINUS_UTC, offsetAt).fields)).toBe(
      '-0044-03-15 12:00:00',
    );
  });

  it('pushes a wall time inside a DST gap forward with the pre-transition offset', () => {
    // Paris 2024-03-31 02:30 does not exist (02:00 -> 03:00): 01:30Z, shown as 03:30 CEST.
    const tt = ttFromLocalCalendar(fields(2024, 3, 31, 2, 30), TT_MINUS_UTC, parisLike);
    expect(utcMsOfTt(tt, TT_MINUS_UTC)).toBeCloseTo(Date.UTC(2024, 2, 31, 1, 30), 0);
    expect(formatCalendar(localCalendarOfTt(tt, TT_MINUS_UTC, parisLike).fields)).toBe(
      '2024-03-31 03:30:00',
    );
  });

  it('takes the earlier instant of a DST overlap', () => {
    // Paris 2024-10-27 02:30 exists twice (03:00 -> 02:00): 00:30Z (CEST) before 01:30Z (CET).
    const tt = ttFromLocalCalendar(fields(2024, 10, 27, 2, 30), TT_MINUS_UTC, parisLike);
    expect(utcMsOfTt(tt, TT_MINUS_UTC)).toBeCloseTo(Date.UTC(2024, 9, 27, 0, 30), 0);
    // Away from the transitions the two samples agree and the single candidate round-trips.
    const plain = ttFromLocalCalendar(fields(2024, 7, 1, 12), TT_MINUS_UTC, parisLike);
    expect(utcMsOfTt(plain, TT_MINUS_UTC)).toBeCloseTo(Date.UTC(2024, 6, 1, 10), 0);
    const winter = ttFromLocalCalendar(fields(2024, 1, 15, 12), TT_MINUS_UTC, parisLike);
    expect(utcMsOfTt(winter, TT_MINUS_UTC)).toBeCloseTo(Date.UTC(2024, 0, 15, 11), 0);
  });

  it('uses the browser zone by default, consistently with getTimezoneOffset', () => {
    const ms = utcMsOfTt(TT_FIXED, TT_MINUS_UTC);
    expect(browserOffsetAt(ms)).toBe(-new Date(ms).getTimezoneOffset());
    const local = localCalendarOfTt(TT_FIXED, TT_MINUS_UTC);
    expect(local.offsetMin).toBe(browserOffsetAt(ms));
    expect(ttFromLocalCalendar(local.fields, TT_MINUS_UTC)).toBeCloseTo(TT_FIXED, 8);
    expect(DAY_MS).toBe(86_400_000);
  });
});

describe('formats', () => {
  it('formats offsets, hours and the Julian Date', () => {
    expect(formatOffset(-296)).toBe('UTC-04:56');
    expect(formatOffset(120)).toBe('UTC+02:00');
    expect(formatOffset(0)).toBe('UTC+00:00');
    expect(formatOffset(9)).toBe('UTC+00:09');
    expect(formatOffset(-30)).toBe('UTC-00:30');
    expect(formatHours(13.5)).toBe('13:30:00');
    expect(formatHours(-0.5)).toBe('23:30:00');
    expect(formatHours(24)).toBe('00:00:00');
    expect(formatHours(0)).toBe('00:00:00');
    expect(formatHours(23.99999)).toBe('23:59:59');
    expect(formatHours(24 - 1e-15)).toBe('00:00:00');
    expect(formatJd(TT_FIXED)).toBe('2460409.25000');
    expect(formatJd(2460409.123456789)).toBe('2460409.12346');
  });

  it('truncates to the second but carries float noise at a boundary', () => {
    expect(formatCalendar(fields(2024, 4, 8, 17, 58, 50.816))).toBe('2024-04-08 17:58:50');
    expect(formatCalendar(fields(2024, 4, 8, 17, 58, 50.998))).toBe('2024-04-08 17:58:50');
    expect(formatCalendar(fields(2024, 4, 8, 17, 58, 59.99997))).toBe('2024-04-08 17:59:00');
    expect(formatCalendar(fields(2024, 12, 31, 23, 59, 59.99999))).toBe('2025-01-01 00:00:00');
    expect(wholeSeconds(fields(-44, 3, 15, 12, 0, 59.99995))).toEqual(fields(-44, 3, 15, 12, 1, 0));
  });

  it('labels UT before 1972 and the signed years', () => {
    expect(isUtLabel(2441317.5)).toBe(false);
    expect(isUtLabel(2441317.4)).toBe(true);
    expect(yearOfTt(TT_FIXED)).toBe(2024);
    expect(formatSignedYear(jdFromCalendar(-44, 3, 15))).toBe('-0044');
    expect(formatSignedYear(jdFromCalendar(0, 6, 1))).toBe('0000');
    expect(formatSignedYear(jdFromCalendar(17191, 1, 1))).toBe('17191');
    expect(formatSignedYear(2396753.5)).toBe('1849');
    expect(formatSignedYear(2506351.5)).toBe('2150');
  });

  it('shows the Gregorian notice before 1582-10-15', () => {
    expect(gregorianNoticeForTt(ttFromUtcJd(GREGORIAN_START_JD, TT_MINUS_UTC), TT_MINUS_UTC)).toBe(
      false,
    );
    expect(
      gregorianNoticeForTt(ttFromUtcJd(GREGORIAN_START_JD - 1, TT_MINUS_UTC), TT_MINUS_UTC),
    ).toBe(true);
  });

  it('names the zone through Intl and falls back to null when Intl throws', () => {
    expect(typeof zoneName()).toBe('string');
    const spy = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => {
      throw new RangeError('no zone');
    });
    expect(zoneName()).toBeNull();
    spy.mockRestore();
  });
});

describe('calendar validation', () => {
  it('knows leap years and month lengths in astronomical numbering', () => {
    expect(isLeapYear(2024)).toBe(true);
    expect(isLeapYear(1900)).toBe(false);
    expect(isLeapYear(2000)).toBe(true);
    expect(isLeapYear(-44)).toBe(true);
    expect(isLeapYear(0)).toBe(true);
    expect(daysInMonth(-44, 2)).toBe(29);
    expect(daysInMonth(1900, 2)).toBe(28);
    expect(daysInMonth(2000, 2)).toBe(29);
    expect(daysInMonth(2024, 4)).toBe(30);
    expect(daysInMonth(2024, 12)).toBe(31);
    expect(daysInMonth(2024, 13)).toBe(0);
    expect(daysInMonth(2024, 0)).toBe(0);
  });

  it('accepts valid fields and refuses impossible ones', () => {
    expect(validateFields(fields(2024, 4, 8, 17, 58, 50.816))).toBeNull();
    expect(validateFields(fields(-44, 2, 29))).toBeNull();
    expect(validateFields(fields(2024, 13, 1))).toBe('invalidDate');
    expect(validateFields(fields(2024, 0, 1))).toBe('invalidDate');
    expect(validateFields(fields(2023, 2, 29))).toBe('invalidDate');
    expect(validateFields(fields(2024, 4, 0))).toBe('invalidDate');
    expect(validateFields(fields(2024, 4, 8, 24))).toBe('invalidDate');
    expect(validateFields(fields(2024, 4, 8, -1))).toBe('invalidDate');
    expect(validateFields(fields(2024, 4, 8, 0, 60))).toBe('invalidDate');
    expect(validateFields(fields(2024, 4, 8, 0, -1))).toBe('invalidDate');
    expect(validateFields(fields(2024, 4, 8, 0, 0, 60))).toBe('invalidDate');
    expect(validateFields(fields(2024, 4, 8, 0, 0, -1))).toBe('invalidDate');
    expect(validateFields(fields(2024, 4, 8, 0, 0, NaN))).toBe('invalidDate');
    expect(validateFields(fields(2024.5, 4, 8))).toBe('invalidDate');
    expect(validateFields(fields(NaN, 4, 8))).toBe('invalidDate');
  });
});

describe('speeds', () => {
  it('builds the signed list defensively', () => {
    expect(speedList([60, 1, 10, 10, -5, 0, NaN, Infinity])).toEqual([-60, -10, -1, 1, 10, 60]);
    expect(speedList([])).toEqual([]);
    expect(speedList(DEFAULT_SPEEDS)).toHaveLength(18);
  });

  it('moves one index in the signed list', () => {
    const list = [-60, -10, -1, 1, 10, 60];
    expect(nextSpeed(list, 0, 1)).toBe(1);
    expect(nextSpeed(list, 0, -1)).toBe(-1);
    expect(nextSpeed(list, 1, 1)).toBe(10);
    expect(nextSpeed(list, 1, -1)).toBe(-1);
    expect(nextSpeed(list, 60, 1)).toBe(60);
    expect(nextSpeed(list, -60, -1)).toBe(-60);
    expect(nextSpeed(list, 5, 1)).toBe(10);
    expect(nextSpeed(list, 5, -1)).toBe(1);
    expect(nextSpeed(list, 100, 1)).toBe(60);
    expect(nextSpeed(list, 100, -1)).toBe(60);
    expect(nextSpeed(list, -100, -1)).toBe(-60);
    expect(nextSpeed(list, -100, 1)).toBe(-60);
    expect(nextSpeed([], 7, 1)).toBe(7);
  });

  it('expresses a speed in the largest exact unit', () => {
    expect(speedParts(1)).toEqual({ unit: 's', count: 1, backward: false });
    expect(speedParts(10)).toEqual({ unit: 's', count: 10, backward: false });
    expect(speedParts(60)).toEqual({ unit: 'min', count: 1, backward: false });
    expect(speedParts(600)).toEqual({ unit: 'min', count: 10, backward: false });
    expect(speedParts(3600)).toEqual({ unit: 'h', count: 1, backward: false });
    expect(speedParts(86400)).toEqual({ unit: 'd', count: 1, backward: false });
    expect(speedParts(604800)).toEqual({ unit: 'wk', count: 1, backward: false });
    expect(speedParts(2629800)).toEqual({ unit: 'mo', count: 1, backward: false });
    expect(speedParts(31557600)).toEqual({ unit: 'yr', count: 1, backward: false });
    expect(speedParts(-3600)).toEqual({ unit: 'h', count: 1, backward: true });
    expect(speedParts(5400)).toEqual({ unit: 'min', count: 90, backward: false });
    expect(speedParts(0.5)).toEqual({ unit: 's', count: 0.5, backward: false });
    expect(speedParts(1.25)).toEqual({ unit: 's', count: 1.3, backward: false });
  });
});

describe('steps', () => {
  it('maps units to stepTime arguments and bodies to their units', () => {
    expect(stepDeltaOf('minute', 1)).toBe(60);
    expect(stepDeltaOf('hour', -1)).toBe(-3600);
    expect(stepDeltaOf('day', 1)).toBe(86400);
    expect(stepDeltaOf('siderealDay', 1)).toBe(SIDEREAL_DAY_S);
    expect(stepDeltaOf('year', -1)).toEqual({ years: -1 });
    expect(stepUnitsFor('earth')).toEqual(['minute', 'hour', 'day', 'siderealDay', 'year']);
    expect(stepUnitsFor('mars')).toEqual(['minute', 'hour', 'day', 'year']);
    expect(stepTargetTt(2460409.25, 3600, 69.184)).toBeCloseTo(2460409.25 + 1 / 24, 12);
  });

  it('shifts by calendar years like the store, February 29 clamped to the 28th', () => {
    // 2024-04-08 12:00 UTC one year on is 2025-04-08 (365 days), one year back 2023-04-08 (366).
    const tt = ttFromUtcCalendar(
      { year: 2024, month: 4, day: 8, hour: 12, minute: 0, second: 0 },
      0,
    );
    expect(shiftYears(tt, 1, 0)).toBeCloseTo(tt + 365, 9);
    expect(shiftYears(tt, -1, 0)).toBeCloseTo(tt - 366, 9);
    expect(stepTargetTt(tt, { years: 1 }, 0)).toBeCloseTo(tt + 365, 9);
    const leap = ttFromUtcCalendar(
      { year: 2024, month: 2, day: 29, hour: 6, minute: 0, second: 0 },
      0,
    );
    expect(utcCalendarOfTt(shiftYears(leap, 1, 0), 0)).toEqual({
      year: 2025,
      month: 2,
      day: 28,
      hour: 6,
      minute: 0,
      second: 0,
    });
    expect(utcCalendarOfTt(shiftYears(leap, 4, 0), 0)).toMatchObject({
      year: 2028,
      month: 2,
      day: 29,
    });
    // The ttMinusUtc offset is carried through unchanged.
    expect(shiftYears(tt, 1, 69.184)).toBeCloseTo(shiftYears(tt, 1, 0), 9);
  });
});

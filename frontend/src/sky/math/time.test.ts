// @vitest-environment node
// Time (plan D75): TT Julian Date arithmetic, the proleptic Gregorian calendar with astronomical
// year numbering over the whole ephemeris range (-13200..17191, negative Julian Dates included),
// the backend `utc_iso` rule, and speed-adaptive sampling (brief l.70).

import { loadFramesFixture, loadHorizonsEpochs, loadStarsFixture } from '../../test/fixtures';
import type { CalendarFields } from './time';
import {
  DAY_MS,
  DAY_S,
  DEFAULT_SAMPLES,
  GREGORIAN_START_JD,
  J2000_TT,
  JULIAN_YEAR_DAYS,
  MAX_SAMPLES,
  MAX_STEP_S,
  MIN_STEP_S,
  SNAPSHOT_REAL_SECONDS,
  UNIX_EPOCH_JD,
  WINDOW_REAL_SECONDS,
  alignTt0,
  calendarFromJd,
  clampStepSeconds,
  clampTt,
  formatYear,
  gregorianNoticeNeeded,
  isSnapshot,
  isoUtcFromTt,
  jdFromCalendar,
  jdFromUnixMs,
  liveTt,
  realSecondsCovered,
  stepSecondsForSpeed,
  ttFromUtcJd,
  unixMsFromJd,
  utcJdFromTt,
  yearsSinceEpoch,
} from './time';

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fields(): CalendarFields {
  return { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
}

// Independent oracle: Howard Hinnant's `days_from_civil` / `civil_from_days` (proleptic
// Gregorian, floor division, valid for negative years), days counted from 1970-01-01.
const UNIX_EPOCH_JDN = 2440588;

function daysFromCivil(y0: number, m: number, d: number): number {
  const y = m <= 2 ? y0 - 1 : y0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m > 2 ? m - 3 : m + 9) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(z0: number): [number, number, number] {
  const z = z0 + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return [m <= 2 ? y + 1 : y, m, d];
}

// DE441 coverage (brief l.307) as TT Julian Dates. JPL's header prints the start as
// "-13200 AUG 15" in the Julian calendar; in the proleptic Gregorian calendar the same day is
// -13200-05-06 (the two calendars are 101 days apart there). The end, 17191-03-15, is Gregorian.
const EPHEMERIS_START_JD = -3100015.5;
const EPHEMERIS_END_JD = 8000016.5;

describe('Julian Date arithmetic', () => {
  it('constants', () => {
    expect(DAY_S).toBe(86400);
    expect(DAY_MS).toBe(86_400_000);
    expect(UNIX_EPOCH_JD).toBe(2440587.5);
    expect(J2000_TT).toBe(2451545.0);
    expect(JULIAN_YEAR_DAYS).toBe(365.25);
  });

  it('converts Unix milliseconds and the TT/UTC offset', () => {
    expect(jdFromUnixMs(0)).toBe(UNIX_EPOCH_JD);
    expect(jdFromUnixMs(DAY_MS)).toBe(UNIX_EPOCH_JD + 1);
    // A Julian Date near 2.46e6 resolves 5e-10 day = 0.04 ms: round trips hold to 0.05 ms.
    expect(unixMsFromJd(jdFromUnixMs(1_700_000_000_000))).toBeCloseTo(1_700_000_000_000, 1);
    expect(ttFromUtcJd(2451545, 64.184)).toBeCloseTo(2451545 + 64.184 / 86400, 12);
    expect(utcJdFromTt(ttFromUtcJd(2451545, 69.184), 69.184)).toBeCloseTo(2451545, 12);
    expect(liveTt(0, 42.184)).toBeCloseTo(UNIX_EPOCH_JD + 42.184 / 86400, 12);
    expect(yearsSinceEpoch(J2000_TT + 365.25 * 24.25, J2000_TT)).toBeCloseTo(24.25, 12);
  });

  it('clampTt clamps into the coverage range (TIME-4)', () => {
    const range: readonly [number, number] = [EPHEMERIS_START_JD, EPHEMERIS_END_JD];
    expect(clampTt(J2000_TT, range)).toBe(J2000_TT);
    expect(clampTt(-4e6, range)).toBe(EPHEMERIS_START_JD);
    expect(clampTt(9e6, range)).toBe(EPHEMERIS_END_JD);
  });
});

describe('calendarFromJd / jdFromCalendar', () => {
  it('anchors: J2000, the Unix epoch, MJD 0, JD 0 and the first Gregorian day', () => {
    expect(calendarFromJd(fields(), 2451545.0)).toEqual({
      year: 2000,
      month: 1,
      day: 1,
      hour: 12,
      minute: 0,
      second: 0,
    });
    expect(jdFromCalendar(2000, 1, 1, 12, 0, 0)).toBe(2451545.0);
    expect(jdFromCalendar(2000, 1, 1)).toBe(2451544.5);
    expect(calendarFromJd(fields(), UNIX_EPOCH_JD)).toMatchObject({
      year: 1970,
      month: 1,
      day: 1,
      hour: 0,
    });
    expect(calendarFromJd(fields(), 2400000.5)).toMatchObject({ year: 1858, month: 11, day: 17 });
    expect(calendarFromJd(fields(), 0)).toMatchObject({
      year: -4713,
      month: 11,
      day: 24,
      hour: 12,
    });
    expect(jdFromCalendar(-4713, 11, 24, 12)).toBe(0);
    expect(calendarFromJd(fields(), 2299160.5)).toMatchObject({
      year: 1582,
      month: 10,
      day: 15,
      hour: 0,
    });
    expect(jdFromCalendar(1582, 10, 15)).toBe(GREGORIAN_START_JD);
    expect(GREGORIAN_START_JD).toBe(2299160.5);
  });

  it('keeps the fractional second and splits the day into fields', () => {
    const c = calendarFromJd(fields(), 2460409.25 + (5 * 3600 + 7 * 60 + 8.25) / DAY_S);
    expect(c).toMatchObject({ year: 2024, month: 4, day: 8, hour: 23, minute: 7 });
    expect(c.second).toBeCloseTo(8.25, 4);
    expect(jdFromCalendar(2024, 4, 8, 23, 7, 8.25)).toBeCloseTo(
      2460409.25 + (5 * 3600 + 7 * 60 + 8.25) / DAY_S,
      10,
    );
  });

  it('matches the ephemeris bounds -13200-05-06 and 17191-03-15 (proleptic Gregorian)', () => {
    expect(calendarFromJd(fields(), EPHEMERIS_START_JD)).toMatchObject({
      year: -13200,
      month: 5,
      day: 6,
      hour: 0,
    });
    expect(calendarFromJd(fields(), EPHEMERIS_END_JD)).toMatchObject({
      year: 17191,
      month: 3,
      day: 15,
      hour: 0,
    });
    expect(jdFromCalendar(-13200, 5, 6)).toBe(EPHEMERIS_START_JD);
    expect(jdFromCalendar(17191, 3, 15)).toBe(EPHEMERIS_END_JD);
    expect(civilFromDays(Math.floor(EPHEMERIS_START_JD + 0.5) - UNIX_EPOCH_JDN)).toEqual([
      -13200, 5, 6,
    ]);
  });

  it('agrees with an independent algorithm on every day-of-month for years across -13200..17191', () => {
    for (let year = -13200; year <= 17191; year += 97) {
      for (const month of [1, 2, 3, 6, 9, 12]) {
        for (const day of [1, 15, 28]) {
          const jdn = daysFromCivil(year, month, day) + UNIX_EPOCH_JDN;
          expect(jdFromCalendar(year, month, day, 12)).toBe(jdn);
          const c = calendarFromJd(fields(), jdn);
          expect([c.year, c.month, c.day]).toEqual([year, month, day]);
        }
      }
    }
  });

  it('round-trips random Julian Dates, negative ones included, through the calendar', () => {
    const next = rng(31);
    for (let k = 0; k < 2000; k += 1) {
      const jd = EPHEMERIS_START_JD + next() * (EPHEMERIS_END_JD - EPHEMERIS_START_JD);
      const c = calendarFromJd(fields(), jd);
      expect(c.month).toBeGreaterThanOrEqual(1);
      expect(c.month).toBeLessThanOrEqual(12);
      expect(c.day).toBeGreaterThanOrEqual(1);
      expect(c.day).toBeLessThanOrEqual(31);
      expect(c.hour).toBeLessThan(24);
      expect(c.minute).toBeLessThan(60);
      expect(c.second).toBeLessThan(60);
      const [y, m, d] = civilFromDays(Math.floor(jd + 0.5) - UNIX_EPOCH_JDN);
      expect([c.year, c.month, c.day]).toEqual([y, m, d]);
      expect(jdFromCalendar(c.year, c.month, c.day, c.hour, c.minute, c.second)).toBeCloseTo(jd, 6);
    }
  });

  it('handles leap days of the proleptic Gregorian rule (year 0 and -100 differ)', () => {
    expect(calendarFromJd(fields(), jdFromCalendar(0, 2, 29))).toMatchObject({
      year: 0,
      month: 2,
      day: 29,
    });
    // -100 is not a leap year (divisible by 100, not 400): Feb 29 rolls into March 1.
    expect(calendarFromJd(fields(), jdFromCalendar(-100, 2, 29))).toMatchObject({
      year: -100,
      month: 3,
      day: 1,
    });
    expect(calendarFromJd(fields(), jdFromCalendar(-400, 2, 29))).toMatchObject({
      year: -400,
      month: 2,
      day: 29,
    });
  });
});

describe('formatYear / isoUtcFromTt / gregorianNoticeNeeded', () => {
  it('formats signed years with at least four digits (brief l.526)', () => {
    expect(formatYear(2024)).toBe('2024');
    expect(formatYear(0)).toBe('0000');
    expect(formatYear(-44)).toBe('-0044');
    expect(formatYear(12345)).toBe('12345');
    expect(formatYear(-13200)).toBe('-13200');
  });

  it('reproduces the fixture TT calendar strings (ttMinusUtc = 0)', () => {
    for (const w of loadFramesFixture().windows) {
      expect(isoUtcFromTt(w.tt0, 0)).toBe(`${w.calendar_tt0}Z`);
    }
    for (const star of loadStarsFixture().stars) {
      for (const sample of star.samples) {
        expect(isoUtcFromTt(sample.tt, 0)).toBe(`${sample.calendar_tt}Z`);
      }
    }
    const epochs = loadHorizonsEpochs();
    expect(epochs.length).toBeGreaterThanOrEqual(6);
    for (const epoch of epochs) {
      expect(isoUtcFromTt(epoch.jd_tt, 0)).toBe(`${epoch.calendar_tt}Z`);
    }
  });

  it('applies the backend rule: +0.5 s then floor, so 59.9999 carries and :60 never prints', () => {
    expect(isoUtcFromTt(J2000_TT - 0.4 / DAY_S, 0)).toBe('2000-01-01T12:00:00Z');
    expect(isoUtcFromTt(J2000_TT - 0.6 / DAY_S, 0)).toBe('2000-01-01T11:59:59Z');
    expect(isoUtcFromTt(J2000_TT + 0.49 / DAY_S, 0)).toBe('2000-01-01T12:00:00Z');
    expect(isoUtcFromTt(J2000_TT + 0.51 / DAY_S, 0)).toBe('2000-01-01T12:00:01Z');
    expect(isoUtcFromTt(J2000_TT, 64.184)).toBe('2000-01-01T11:58:56Z');
    expect(isoUtcFromTt(jdFromCalendar(-44, 3, 15), 0)).toBe('-0044-03-15T00:00:00Z');
    expect(isoUtcFromTt(jdFromCalendar(0, 12, 31, 23, 59, 59.7), 0)).toBe('0001-01-01T00:00:00Z');
  });

  it('flags dates before 1582-10-15 for the proleptic notice (TIME-2)', () => {
    expect(gregorianNoticeNeeded(GREGORIAN_START_JD)).toBe(false);
    expect(gregorianNoticeNeeded(GREGORIAN_START_JD - 1)).toBe(true);
    expect(gregorianNoticeNeeded(J2000_TT)).toBe(false);
    expect(gregorianNoticeNeeded(0)).toBe(true);
  });
});

describe('speed-adaptive sampling (brief l.70)', () => {
  const stepClassOf = new Map<string, string>([
    ['sun', 'sun_and_outer'],
    ['moon', 'moon'],
    ['mars', 'inner_planets'],
    ['jupiter', 'sun_and_outer'],
    ['odd', 'unknown_class'],
  ]);
  const maxStepS = { moon: 3600, inner_planets: 21600, sun_and_outer: 86400, minor: 86400 };

  it('constants', () => {
    expect(MAX_SAMPLES).toBe(64);
    expect(DEFAULT_SAMPLES).toBe(32);
    expect(WINDOW_REAL_SECONDS).toBe(60);
    expect(SNAPSHOT_REAL_SECONDS).toBe(5);
    expect(MIN_STEP_S).toBe(1);
    // One Julian year, the `step_s` ceiling of docs/api.md "Canonicalization".
    expect(MAX_STEP_S).toBe(31_557_600);
  });

  it('stepSecondsForSpeed = max(1, ceil(|speed| * 60 / 32))', () => {
    expect(stepSecondsForSpeed(3600)).toBe(6750);
    expect(stepSecondsForSpeed(-3600)).toBe(6750);
    expect(stepSecondsForSpeed(0)).toBe(1);
    expect(stepSecondsForSpeed(1)).toBe(2);
    expect(stepSecondsForSpeed(0.1)).toBe(1);
    expect(stepSecondsForSpeed(86400)).toBe(162000);
  });

  it('clampStepSeconds applies the smallest class maximum of the requested bodies', () => {
    expect(clampStepSeconds(6750, ['sun', 'moon', 'mars'], stepClassOf, maxStepS, false)).toBe(
      3600,
    );
    expect(clampStepSeconds(6750, ['sun', 'jupiter'], stepClassOf, maxStepS, false)).toBe(6750);
    expect(clampStepSeconds(162000, ['sun', 'jupiter'], stepClassOf, maxStepS, false)).toBe(86400);
    expect(clampStepSeconds(162000, ['mars'], stepClassOf, maxStepS, false)).toBe(21600);
    expect(clampStepSeconds(162000, [], stepClassOf, maxStepS, true)).toBe(86400);
    expect(clampStepSeconds(162000, [], stepClassOf, maxStepS, false)).toBe(162000);
  });

  it('clampStepSeconds never exceeds the API ceiling, even without a class limit', () => {
    // With no body and no minor body no class limit applies; at the maximum speed
    // `stepSecondsForSpeed` (59 170 500 s) would leave for the API above its `[1, 31557600]`
    // range, so the contract ceiling is applied last.
    expect(stepSecondsForSpeed(31_557_600)).toBe(59_170_500);
    expect(clampStepSeconds(59_170_500, [], stepClassOf, maxStepS, false)).toBe(MAX_STEP_S);
    expect(clampStepSeconds(59_170_500, ['moon'], stepClassOf, maxStepS, false)).toBe(3600);
    expect(clampStepSeconds(MAX_STEP_S, [], stepClassOf, maxStepS, false)).toBe(MAX_STEP_S);
  });

  it('clampStepSeconds throws on an unknown body or class (contract drift)', () => {
    expect(() => clampStepSeconds(10, ['pluto'], stepClassOf, maxStepS, false)).toThrow(RangeError);
    expect(() => clampStepSeconds(10, ['odd'], stepClassOf, maxStepS, false)).toThrow(
      /unknown step class/,
    );
    expect(() => clampStepSeconds(10, [], stepClassOf, { moon: 3600 }, true)).toThrow(RangeError);
  });

  it('alignTt0 floors to a multiple of the step', () => {
    const tt = 2460409.2534;
    const aligned = alignTt0(tt, 300);
    expect(aligned).toBeCloseTo(2460409.25, 9);
    expect(aligned).toBeLessThanOrEqual(tt);
    expect(tt - aligned).toBeLessThan(300 / DAY_S);
    expect(alignTt0(2460409.25, 86400)).toBe(2460409);
    expect(alignTt0(-3100015.2, 3600)).toBeCloseTo(-3100015 - 5 / 24, 9);
  });

  it('snapshot thresholds: Moon at 86400x is a snapshot, inner planets at 86400x a window', () => {
    const moonStep = clampStepSeconds(
      stepSecondsForSpeed(86400),
      ['moon'],
      stepClassOf,
      maxStepS,
      false,
    );
    expect(moonStep).toBe(3600);
    expect(realSecondsCovered(moonStep, 32, 86400)).toBeCloseTo(31 / 24, 12);
    expect(isSnapshot(moonStep, 32, 86400)).toBe(true);
    const marsStep = clampStepSeconds(
      stepSecondsForSpeed(86400),
      ['mars'],
      stepClassOf,
      maxStepS,
      false,
    );
    expect(marsStep).toBe(21600);
    expect(realSecondsCovered(marsStep, 32, 86400)).toBeCloseTo(7.75, 12);
    expect(isSnapshot(marsStep, 32, 86400)).toBe(false);
    expect(isSnapshot(1, 32, 0)).toBe(false);
    expect(realSecondsCovered(1, 32, 0)).toBe(31 / 1e-9);
    expect(isSnapshot(1, 32, 1)).toBe(false);
  });
});

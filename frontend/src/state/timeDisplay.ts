// Time display and editing helpers (TIME-1..TIME-3, brief l.201-203, l.51, l.526, l.553; plan
// D98, D99). Pure: the calendar arithmetic is `sky/math/time.ts` (proleptic Gregorian,
// astronomical year numbering), the wall clock enters only as an injected `offsetAt` function
// (the browser's `-getTimezoneOffset()` at an instant, integer minutes, tzdata for every year the
// ephemeris covers) so the tests are independent of the machine's zone. `Date` is never asked to
// parse or build a calendar date: years 0..99 would land in 1900..1999 and negative years cannot
// be parsed at all (brief l.526).

import {
  DAY_MS,
  DAY_S,
  calendarFromJd,
  formatYear,
  gregorianNoticeNeeded,
  jdFromCalendar,
  jdFromUnixMs,
  ttFromUtcJd,
  unixMsFromJd,
  utcJdFromTt,
} from '../sky/math/time';
import type { CalendarFields } from '../sky/math/time';
import type { StepUnit } from './types';

export type { CalendarFields } from '../sky/math/time';

/** Zone offset in minutes east of UTC at a UTC instant (`Date` follows the browser's tzdata). */
export type OffsetAt = (utcMs: number) => number;

/** The browser's zone offset at an instant, minutes east of UTC (integer; LMT before 1900). */
export function browserOffsetAt(utcMs: number): number {
  return -new Date(utcMs).getTimezoneOffset();
}

function emptyFields(): CalendarFields {
  return { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
}

/** Unix milliseconds (UTC) of a TT instant. */
export function utcMsOfTt(tt: number, ttMinusUtcS: number): number {
  return unixMsFromJd(utcJdFromTt(tt, ttMinusUtcS));
}

/** UTC calendar fields of a TT instant. */
export function utcCalendarOfTt(tt: number, ttMinusUtcS: number): CalendarFields {
  return calendarFromJd(emptyFields(), utcJdFromTt(tt, ttMinusUtcS));
}

export interface LocalCalendar {
  fields: CalendarFields;
  /** Minutes east of UTC at that instant. */
  offsetMin: number;
}

/** Local calendar fields of a TT instant under the zone `offsetAt` describes. */
export function localCalendarOfTt(
  tt: number,
  ttMinusUtcS: number,
  offsetAt: OffsetAt = browserOffsetAt,
): LocalCalendar {
  const utcJd = utcJdFromTt(tt, ttMinusUtcS);
  const offsetMin = offsetAt(unixMsFromJd(utcJd));
  return { fields: calendarFromJd(emptyFields(), utcJd + offsetMin / 1440), offsetMin };
}

/** TT of UTC calendar fields. */
export function ttFromUtcCalendar(f: CalendarFields, ttMinusUtcS: number): number {
  return ttFromUtcJd(
    jdFromCalendar(f.year, f.month, f.day, f.hour, f.minute, f.second),
    ttMinusUtcS,
  );
}

/**
 * TT of local calendar fields (TIME-2). The wall time is read as if it were UTC, the offset is
 * sampled one day before and one day after, and every candidate instant whose offset reproduces
 * the wall time is kept: an overlap (clocks turned back) yields two and the earlier wins; a gap
 * (clocks turned forward) yields none and the pre-transition offset applies, which pushes the
 * instant forward across the gap (Temporal's `disambiguation: 'compatible'`).
 */
export function ttFromLocalCalendar(
  f: CalendarFields,
  ttMinusUtcS: number,
  offsetAt: OffsetAt = browserOffsetAt,
): number {
  const wallMs = unixMsFromJd(jdFromCalendar(f.year, f.month, f.day, f.hour, f.minute, f.second));
  const before = offsetAt(wallMs - DAY_MS);
  const after = offsetAt(wallMs + DAY_MS);
  const offsets = before === after ? [before] : [before, after];
  let chosen: number | null = null;
  for (const offset of offsets) {
    const candidate = wallMs - offset * 60_000;
    if (offsetAt(candidate) === offset && (chosen === null || candidate < chosen)) {
      chosen = candidate;
    }
  }
  const utcMs = chosen ?? wallMs - before * 60_000;
  return ttFromUtcJd(jdFromUnixMs(utcMs), ttMinusUtcS);
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Float noise of the Julian Date arithmetic at the ephemeris bounds (1.5e-4 s) stays below this. */
const SECOND_GUARD_S = 1e-3;

/**
 * The fields truncated to the whole second, carried through the calendar: `59.99997 s` reads as
 * the next minute's `:00`, never as `:59`, so a readout or an editor draft at a second boundary
 * shows the second the instant belongs to (the guard is far below the display resolution).
 */
export function wholeSeconds(c: CalendarFields): CalendarFields {
  const jd = jdFromCalendar(c.year, c.month, c.day, c.hour, c.minute, c.second);
  const r = calendarFromJd(emptyFields(), jd + SECOND_GUARD_S / DAY_S);
  r.second = Math.floor(r.second);
  return r;
}

/** `YYYY-MM-DD hh:mm:ss` with a signed year of at least four digits and whole seconds. */
export function formatCalendar(c: CalendarFields): string {
  const r = wholeSeconds(c);
  return `${formatYear(r.year)}-${pad2(r.month)}-${pad2(r.day)} ${pad2(r.hour)}:${pad2(r.minute)}:${pad2(r.second)}`;
}

/** `UTC+02:00`, `UTC-04:56`, `UTC+00:00` from minutes east of UTC. */
export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `UTC${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/** `hh:mm:ss` of a time in hours wrapped into `[0, 24)` (the LAST readout). */
export function formatHours(hours: number): string {
  const wrapped = ((hours % 24) + 24) % 24;
  let total = Math.floor(wrapped * 3600);
  if (total >= DAY_S) {
    total -= DAY_S;
  }
  const h = Math.floor(total / 3600);
  const m = Math.floor((total - h * 3600) / 60);
  const s = total - h * 3600 - m * 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

/** TT Julian Date with five decimals (the readout's third line). */
export function formatJd(tt: number): string {
  return tt.toFixed(5);
}

/** 1972-01-01T00:00 UTC: before it the second line is UT (TT - UT1), docs/api.md. */
export const UT_LABEL_BEFORE_JD = 2441317.5;

/** `true` when the "UTC" line should read UT (the backend hands TT - UT1 before 1972). */
export function isUtLabel(tt: number): boolean {
  return tt < UT_LABEL_BEFORE_JD;
}

/** Proleptic Gregorian leap year, astronomical numbering (`%` keeps the sign, `-0 === 0`). */
export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/** Days of a month (1-12) in a proleptic Gregorian year; `0` for an invalid month. */
export function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }
  return MONTH_DAYS[month - 1] ?? 0;
}

export type FieldsError = 'invalidDate';

/** `null` when the fields make a calendar date and time, else the editor's error code. */
export function validateFields(f: CalendarFields): FieldsError | null {
  const integers = [f.year, f.month, f.day, f.hour, f.minute].every((v) => Number.isInteger(v));
  if (!integers || !Number.isFinite(f.second)) {
    return 'invalidDate';
  }
  if (f.month < 1 || f.month > 12 || f.day < 1 || f.day > daysInMonth(f.year, f.month)) {
    return 'invalidDate';
  }
  if (
    f.hour < 0 ||
    f.hour > 23 ||
    f.minute < 0 ||
    f.minute > 59 ||
    f.second < 0 ||
    f.second >= 60
  ) {
    return 'invalidDate';
  }
  return null;
}

/** The calendar year of a TT instant (the ephemeris bounds as signed years). */
export function yearOfTt(tt: number): number {
  return calendarFromJd(emptyFields(), tt).year;
}

/** `-0044`, `2024`: the signed year of a TT instant for the coverage lines. */
export function formatSignedYear(tt: number): string {
  return formatYear(yearOfTt(tt));
}

/** Whether the editor shows the proleptic Gregorian notice for an instant (TIME-2). */
export function gregorianNoticeForTt(tt: number, ttMinusUtcS: number): boolean {
  return gregorianNoticeNeeded(utcJdFromTt(tt, ttMinusUtcS));
}

/** The browser's IANA zone name, `null` when `Intl` cannot say (exotic environments). */
export function zoneName(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Transport (TIME-3, TIME-5): the signed speed list and its labels.

/** `/meta.limits.speeds` before `/meta` answers (the brief's list, l.50). */
export const DEFAULT_SPEEDS: readonly number[] = [
  1, 10, 60, 600, 3600, 86400, 604800, 2629800, 31557600,
];

/**
 * The signed speed list: the positive finite speeds of `/meta.limits.speeds`, deduplicated and
 * sorted (defensively: the contract does not promise an order), mirrored to their negatives,
 * ascending from the fastest backward to the fastest forward.
 */
export function speedList(speeds: readonly number[]): number[] {
  const positive = [...new Set(speeds.filter((s) => Number.isFinite(s) && s > 0))].sort(
    (a, b) => a - b,
  );
  return [...positive.map((s) => -s).reverse(), ...positive];
}

/**
 * The speed one step from `speed` in a signed list (`.` forward, `,` backward): from a pause
 * (`0`) the first forward or backward speed; from a speed outside the list, the nearest entry in
 * that direction; at either end the end.
 */
export function nextSpeed(list: readonly number[], speed: number, direction: 1 | -1): number {
  if (list.length === 0) {
    return speed;
  }
  const exact = list.indexOf(speed);
  let index: number;
  if (exact >= 0) {
    index = exact + direction;
  } else {
    // The insertion point: the first entry above `speed`.
    const above = list.findIndex((s) => s > speed);
    const insertion = above === -1 ? list.length : above;
    index = direction > 0 ? insertion : insertion - 1;
  }
  const clamped = Math.max(0, Math.min(list.length - 1, index));
  return list[clamped] ?? speed;
}

export type SpeedUnit = 's' | 'min' | 'h' | 'd' | 'wk' | 'mo' | 'yr';

export interface SpeedParts {
  unit: SpeedUnit;
  /** Simulated units per real second, positive. */
  count: number;
  backward: boolean;
}

const SPEED_UNITS: readonly { unit: SpeedUnit; seconds: number }[] = [
  { unit: 'yr', seconds: 31557600 },
  { unit: 'mo', seconds: 2629800 },
  { unit: 'wk', seconds: 604800 },
  { unit: 'd', seconds: 86400 },
  { unit: 'h', seconds: 3600 },
  { unit: 'min', seconds: 60 },
  { unit: 's', seconds: 1 },
];

/**
 * A speed as a count of the largest unit dividing it exactly (`3600` -> 1 h, `600` -> 10 min);
 * a speed no unit divides is expressed in the largest unit below it, to one decimal.
 */
export function speedParts(speed: number): SpeedParts {
  const magnitude = Math.abs(speed);
  const backward = speed < 0;
  for (const { unit, seconds } of SPEED_UNITS) {
    if (magnitude >= seconds && Number.isInteger(magnitude / seconds)) {
      return { unit, count: magnitude / seconds, backward };
    }
  }
  const largest = SPEED_UNITS.find(({ seconds }) => magnitude >= seconds) ?? {
    unit: 's',
    seconds: 1,
  };
  return {
    unit: largest.unit,
    count: Math.round((magnitude / largest.seconds) * 10) / 10,
    backward,
  };
}

// ---------------------------------------------------------------------------------------------
// Steps (TIME-3): what one press of a step button or of `[` / `]` shifts.

/** One mean sidereal day in SI seconds (the sky repeats; Earth only). */
export const SIDEREAL_DAY_S = 86164.0905;

export type StepDelta = number | { years: 1 | -1 };

/** The `stepTime` argument of one step of `unit` in `direction`. */
export function stepDeltaOf(unit: StepUnit, direction: 1 | -1): StepDelta {
  switch (unit) {
    case 'minute':
      return 60 * direction;
    case 'hour':
      return 3600 * direction;
    case 'day':
      return DAY_S * direction;
    case 'siderealDay':
      return SIDEREAL_DAY_S * direction;
    case 'year':
      return { years: direction };
  }
}

/** The step units offered on a body: the sidereal day is Earth's alone. */
export function stepUnitsFor(body: string): readonly StepUnit[] {
  return body === 'earth'
    ? ['minute', 'hour', 'day', 'siderealDay', 'year']
    : ['minute', 'hour', 'day', 'year'];
}

// Scratch calendar of `shiftYears` (the store's `stepTime` never allocates for a time step).
const shiftScratch = emptyFields();

/**
 * The same UTC calendar date and time `years` calendar years away: the one rule of the store's
 * `stepTime({ years })` and of the bound check of `StepButtons` (a February 29 lands on February
 * 28 when the target year has none), so the check agrees with the step it guards (365 or 366
 * days, never a mean 365.25).
 */
export function shiftYears(tt: number, years: number, ttMinusUtcS: number): number {
  const c = calendarFromJd(shiftScratch, utcJdFromTt(tt, ttMinusUtcS));
  const year = c.year + years;
  const day = c.month === 2 && c.day === 29 && !isLeapYear(year) ? 28 : c.day;
  return ttFromUtcJd(jdFromCalendar(year, c.month, day, c.hour, c.minute, c.second), ttMinusUtcS);
}

/** The TT instant one step of `delta` lands on from `tt`, as `stepTime` computes it. */
export function stepTargetTt(tt: number, delta: StepDelta, ttMinusUtcS: number): number {
  return typeof delta === 'number' ? tt + delta / DAY_S : shiftYears(tt, delta.years, ttMinusUtcS);
}

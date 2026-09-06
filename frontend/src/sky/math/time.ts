// Time on the TT Julian Date scale (plan D75). Pure, dependency-free.
//
// Simulation time is a TT Julian Date (float64, brief l.49). "UTC" is reached through the
// backend-supplied `tt_minus_utc_seconds` (TT - UT1 before 1972, brief l.51); the client never
// computes time scales itself. The wall clock enters only through `jdFromUnixMs`.

/** Seconds per day. */
export const DAY_S = 86400;
/** Milliseconds per day. */
export const DAY_MS = 86_400_000;
/** Julian Date of the Unix epoch, 1970-01-01T00:00:00 UTC. */
export const UNIX_EPOCH_JD = 2440587.5;
/** J2000.0 as a TT Julian Date. */
export const J2000_TT = 2451545.0;
/** Days per Julian year (the unit of the SKYS proper-motion column). */
export const JULIAN_YEAR_DAYS = 365.25;

/** UTC Julian Date of a Unix time in milliseconds (`Date.now()`). */
export function jdFromUnixMs(ms: number): number {
  return ms / DAY_MS + UNIX_EPOCH_JD;
}

/** Unix time in milliseconds of a UTC Julian Date. */
export function unixMsFromJd(jd: number): number {
  return (jd - UNIX_EPOCH_JD) * DAY_MS;
}

/** TT Julian Date from a UTC Julian Date and `tt_minus_utc_seconds`. */
export function ttFromUtcJd(utcJd: number, ttMinusUtcS: number): number {
  return utcJd + ttMinusUtcS / DAY_S;
}

/** UTC Julian Date from a TT Julian Date and `tt_minus_utc_seconds`. */
export function utcJdFromTt(tt: number, ttMinusUtcS: number): number {
  return tt - ttMinusUtcS / DAY_S;
}

/** The TT Julian Date "now" in live mode (brief l.50): wall clock -> UTC -> TT. */
export function liveTt(nowMs: number, ttMinusUtcS: number): number {
  return ttFromUtcJd(jdFromUnixMs(nowMs), ttMinusUtcS);
}

/** Julian years elapsed since `epochTt` (the SKYS `years_since_epoch` uniform, brief l.138). */
export function yearsSinceEpoch(tt: number, epochTt: number): number {
  return (tt - epochTt) / JULIAN_YEAR_DAYS;
}

/** Clamp a TT Julian Date into a coverage range `[start, end]` (TIME-4). */
export function clampTt(tt: number, range: readonly [number, number]): number {
  return Math.max(range[0], Math.min(range[1], tt));
}

// ---------------------------------------------------------------------------------------------
// Calendar (plan D75, brief l.51, l.108, l.526): proleptic Gregorian with astronomical year
// numbering (year 0 exists, 45 BC is -44), our own Julian Date arithmetic (never `Date`, which
// cannot parse negative years, and never a date library). The algorithm is Richards' (Explanatory
// Supplement to the Astronomical Almanac, 3rd ed., ch. 15; the one Wikipedia "Julian day"
// reproduces) with `s = 153` (the five-month day count) and floor division/modulo so it holds
// for negative Julian Dates down to the ephemeris start (-13200).

/** Calendar fields; `second` keeps its fraction. */
export interface CalendarFields {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

function floorMod(a: number, b: number): number {
  return a - b * Math.floor(a / b);
}

// Richards' constants for the Gregorian calendar.
const RICHARDS_Y = 4716;
const RICHARDS_J = 1401;
const RICHARDS_M = 2;
const RICHARDS_N = 12;
const RICHARDS_R = 4;
const RICHARDS_P = 1461;
const RICHARDS_V = 3;
const RICHARDS_U = 5;
const RICHARDS_S = 153;
const RICHARDS_W = 2;
const RICHARDS_B = 274277;
const RICHARDS_C = -38;
const RICHARDS_A = 184;

/** Proleptic Gregorian calendar of a Julian Date (any time scale), written into `out`. */
export function calendarFromJd(out: CalendarFields, jd: number): CalendarFields {
  const jdn = Math.floor(jd + 0.5);
  const dayFraction = jd + 0.5 - jdn;
  const f =
    jdn +
    RICHARDS_J +
    floorDiv(floorDiv(RICHARDS_R * jdn + RICHARDS_B, 146097) * 3, RICHARDS_R) +
    RICHARDS_C;
  const e = RICHARDS_R * f + RICHARDS_V;
  const g = floorDiv(floorMod(e, RICHARDS_P), RICHARDS_R);
  const h = RICHARDS_U * g + RICHARDS_W;
  out.day = floorDiv(floorMod(h, RICHARDS_S), RICHARDS_U) + 1;
  out.month = floorMod(floorDiv(h, RICHARDS_S) + RICHARDS_M, RICHARDS_N) + 1;
  out.year =
    floorDiv(e, RICHARDS_P) -
    RICHARDS_Y +
    floorDiv(RICHARDS_N + RICHARDS_M - out.month, RICHARDS_N);
  const seconds = dayFraction * DAY_S;
  out.hour = Math.floor(seconds / 3600);
  out.minute = Math.floor((seconds - out.hour * 3600) / 60);
  out.second = seconds - out.hour * 3600 - out.minute * 60;
  return out;
}

/** Julian Date of a proleptic Gregorian date and time (the inverse of `calendarFromJd`). */
export function jdFromCalendar(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): number {
  const h = month - RICHARDS_M;
  const g = year + RICHARDS_Y - floorDiv(RICHARDS_N - h, RICHARDS_N);
  const f = floorMod(h - 1 + RICHARDS_N, RICHARDS_N);
  const e = floorDiv(RICHARDS_P * g, RICHARDS_R) + day - 1 - RICHARDS_J;
  const julian = e + floorDiv(RICHARDS_S * f + 2, RICHARDS_U);
  const jdn = julian - floorDiv(3 * floorDiv(g + RICHARDS_A, 100), 4) - RICHARDS_C;
  return jdn - 0.5 + (hour * 3600 + minute * 60 + second) / DAY_S;
}

/** Signed year with at least four digits: `-0044`, `0000`, `2024`, `12345` (brief l.526). */
export function formatYear(year: number): string {
  const digits = String(Math.abs(year)).padStart(4, '0');
  return year < 0 ? `-${digits}` : digits;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * `YYYY-MM-DDThh:mm:ssZ` of a TT instant, the rule of the backend `utc_iso`
 * (`astro/time.py`): shift by +0.5 s, then floor every field, so `59.9999 s` carries into the
 * next minute and `:60` never prints. `ttMinusUtcS` is the window's `tt_minus_utc_seconds`.
 */
export function isoUtcFromTt(tt: number, ttMinusUtcS: number): string {
  const c = calendarFromJd(
    { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 },
    utcJdFromTt(tt, ttMinusUtcS) + 0.5 / DAY_S,
  );
  const date = `${formatYear(c.year)}-${pad2(c.month)}-${pad2(c.day)}`;
  return `${date}T${pad2(c.hour)}:${pad2(c.minute)}:${pad2(Math.floor(c.second))}Z`;
}

/** Julian Date of 1582-10-15T00:00, the first Gregorian day. */
export const GREGORIAN_START_JD = 2299160.5;

/** Dates before 1582-10-15 are proleptic Gregorian and the editor says so (TIME-2). */
export function gregorianNoticeNeeded(jd: number): boolean {
  return jd < GREGORIAN_START_JD;
}

// ---------------------------------------------------------------------------------------------
// Speed-adaptive sampling (plan D75, brief l.70).

/** `limits.max_samples` of the API. */
export const MAX_SAMPLES = 64;
/** Window length used in window mode. */
export const DEFAULT_SAMPLES = 32;
/** A window should cover about this much real time at the current speed. */
export const WINDOW_REAL_SECONDS = 60;
/** Below this real-time coverage the client switches to snapshot mode. */
export const SNAPSHOT_REAL_SECONDS = 5;
export const MIN_STEP_S = 1;
/** The API ceiling on `step_s`, one Julian year (docs/api.md "Canonicalization"). */
export const MAX_STEP_S = 31_557_600;

/** `max(1, ceil(|speed| * 60 / 32))`: integer seconds so 32 samples cover about 60 s of real time. */
export function stepSecondsForSpeed(speed: number): number {
  return Math.max(MIN_STEP_S, Math.ceil((Math.abs(speed) * WINDOW_REAL_SECONDS) / DEFAULT_SAMPLES));
}

/**
 * Clamp `stepS` to the smallest `max_step_s` class maximum among the requested bodies (and the
 * `minor` class when any minor body is requested), the rule the backend applies and echoes
 * (docs/api.md "Canonicalization"), and never above `MAX_STEP_S`, the contract's own ceiling
 * (with no body and no minor body the class limit is absent, and `stepSecondsForSpeed` at the
 * maximum speed would otherwise exceed it). `stepClassOf` maps `/meta.bodies[].id` to
 * `step_class`, `maxStepS` is `/meta.limits.max_step_s`. Throws `RangeError` on an unknown body
 * or class so a contract drift is caught at `/meta` load, not by a silently uncapped request.
 */
export function clampStepSeconds(
  stepS: number,
  bodyIds: readonly string[],
  stepClassOf: ReadonlyMap<string, string>,
  maxStepS: Readonly<Record<string, number>>,
  hasMinor: boolean,
): number {
  let limit = Infinity;
  const classes: string[] = [];
  for (const id of bodyIds) {
    const cls = stepClassOf.get(id);
    if (cls === undefined) {
      throw new RangeError(`unknown body id ${id}`);
    }
    classes.push(cls);
  }
  if (hasMinor) {
    classes.push('minor');
  }
  for (const cls of classes) {
    const max = maxStepS[cls];
    if (max === undefined) {
      throw new RangeError(`unknown step class ${cls}`);
    }
    limit = Math.min(limit, max);
  }
  return Math.min(stepS, limit, MAX_STEP_S);
}

/** Align a window start to a multiple of the step, so identical requests share the cache. */
export function alignTt0(tt: number, stepS: number): number {
  const stepD = stepS / DAY_S;
  return Math.floor(tt / stepD) * stepD;
}

/** Real seconds a window of `n` samples covers at `speed` (`|speed|` floored at 1e-9). */
export function realSecondsCovered(stepS: number, n: number, speed: number): number {
  return ((n - 1) * stepS) / Math.max(Math.abs(speed), 1e-9);
}

/** Snapshot mode when the window would cover less than 5 s of real time (brief l.70). */
export function isSnapshot(stepS: number, n: number, speed: number): boolean {
  return realSecondsCovered(stepS, n, speed) < SNAPSHOT_REAL_SECONDS;
}

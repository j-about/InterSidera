// Atmospheric refraction on Earth (brief l.90, plan D73, backlog B-50). Pure, dependency-free.
//
// The reference the client must match within 1 arcmin above -1 degree is Skyfield's
// `altaz(temperature_C='standard', pressure_mbar='standard')`, i.e. `earthlib.refract`: Bennett's
// (1982) formula, written for the apparent altitude, inverted by fixed-point iteration from the
// true altitude, at 10 C and `1010 * exp(-elevation_m / 9100)` mbar, zero below -1 and above
// 89.9 degrees. Sæmundsson's formula (Meeus ch. 16) takes the true altitude directly but misses
// the fixture by about 2 arcmin at 2850 m near the horizon, so the shared forward formula is a
// Sæmundsson seed followed by two Bennett corrections (`apparentAltitudeDeg`); measured 0.057
// arcmin against both fixture tables (2850 m, -1 degree row, 2026-09-06). The star shaders mirror
// `apparentAltitudeDeg` line by line, range guards included; the CPU body path and the debug hook
// call it, so stars and bodies share one apparent frame.
//
// Scale factor: both formulas are multiplied by `factor = (P / 1010) * (283 / (273 + T))`, the
// Sæmundsson/Meeus form. Skyfield scales Bennett by `0.28 P / (T + 273)` instead, which is
// `1010 * 0.28 / 283 = 0.99929` times ours (a 0.07 % difference, below 0.03 arcmin at the
// horizon). We keep one factor so both formulas share it; `skyfieldRefractDeg` reproduces
// Skyfield exactly and exists for the tests only.

import { DEG } from './frames';

export const STANDARD_TEMPERATURE_C = 10;
export const STANDARD_PRESSURE_MBAR = 1010;
/** Scale height of Skyfield's `'standard'` pressure (toposlib.py). */
export const PRESSURE_SCALE_HEIGHT_M = 9100;
/** Skyfield's cut: no refraction below this true altitude ... */
export const MIN_REFRACTED_ALT_DEG = -1;
/** ... nor above this one (degrees). */
export const MAX_REFRACTED_ALT_DEG = 89.9;

const ARCMIN_TO_DEG = 1 / 60;
/** Skyfield's `0.016667` degrees per arcmin, kept verbatim so the oracle matches to 1e-6 deg. */
const SKYFIELD_ARCMIN_DEG = 0.016667;
const SKYFIELD_TOLERANCE_DEG = 3e-5;
const SKYFIELD_MAX_ITERATIONS = 20;

/** Skyfield's `'standard'` pressure at an elevation: `1010 * exp(-elev / 9100)` mbar. */
export function standardPressureMbar(elevM: number): number {
  return STANDARD_PRESSURE_MBAR * Math.exp(-elevM / PRESSURE_SCALE_HEIGHT_M);
}

/** The shared pressure/temperature factor `(P / 1010) * (283 / (273 + T))`. */
export function refractionFactor(elevM: number, tempC = STANDARD_TEMPERATURE_C): number {
  return (standardPressureMbar(elevM) / STANDARD_PRESSURE_MBAR) * (283 / (273 + tempC));
}

function inRefractedRange(altDeg: number): boolean {
  return altDeg >= MIN_REFRACTED_ALT_DEG && altDeg <= MAX_REFRACTED_ALT_DEG;
}

/**
 * Sæmundsson's refraction in degrees for a TRUE altitude: `1.02' / tan(h + 10.3 / (h + 5.11))`
 * times `factor`; zero outside `[-1, 89.9]`.
 */
export function saemundssonRefractionDeg(hTrueDeg: number, factor: number): number {
  if (!inRefractedRange(hTrueDeg)) {
    return 0;
  }
  const arg = (hTrueDeg + 10.3 / (hTrueDeg + 5.11)) * DEG;
  return (1.02 / Math.tan(arg)) * ARCMIN_TO_DEG * factor;
}

/**
 * Bennett's refraction in degrees for an APPARENT altitude: `1' / tan(h + 7.31 / (h + 4.4))` times
 * `factor`; zero outside `[-1, 89.9]` on the apparent argument.
 */
export function bennettRefractionDeg(hApparentDeg: number, factor: number): number {
  if (!inRefractedRange(hApparentDeg)) {
    return 0;
  }
  const arg = (hApparentDeg + 7.31 / (hApparentDeg + 4.4)) * DEG;
  return (1 / Math.tan(arg)) * ARCMIN_TO_DEG * factor;
}

/**
 * THE forward formula, true -> apparent altitude (plan D73): Sæmundsson seed, then two fixed
 * Bennett corrections `a = h + B(a)`. Altitudes below -1 or above 89.9 degrees are returned
 * unchanged. The star shaders implement the two range guards (this one on the true altitude and
 * the one inside `bennettRefractionDeg` on each apparent argument `a0`, `a1`) plus these three
 * lines, so the "identical" claim of D73 holds at 89.9 degrees too (where the inner guard zeroes
 * the second correction).
 */
export function apparentAltitudeDeg(hTrueDeg: number, factor: number): number {
  if (!inRefractedRange(hTrueDeg)) {
    return hTrueDeg;
  }
  const a0 = hTrueDeg + saemundssonRefractionDeg(hTrueDeg, factor);
  const a1 = hTrueDeg + bennettRefractionDeg(a0, factor);
  return hTrueDeg + bennettRefractionDeg(a1, factor);
}

/** The UI inverse, apparent -> true altitude: `h - B(h)` (brief l.90 "Bennett's inverse"). */
export function trueAltitudeDeg(hApparentDeg: number, factor: number): number {
  return hApparentDeg - bennettRefractionDeg(hApparentDeg, factor);
}

/** Skyfield `earthlib.refraction`: Bennett with the `0.28 P / (T + 273)` factor, in degrees. */
function skyfieldRefractionDeg(altDeg: number, tempC: number, pressureMbar: number): number {
  if (!inRefractedRange(altDeg)) {
    return 0;
  }
  const r = SKYFIELD_ARCMIN_DEG / Math.tan((altDeg + 7.31 / (altDeg + 4.4)) * DEG);
  return r * ((0.28 * pressureMbar) / (tempC + 273));
}

/**
 * Skyfield `earthlib.refract`, the test oracle: iterate `alt = true + refraction(alt)` until the
 * step is at most 3e-5 degrees; capped at 20 iterations (Skyfield has no cap, but an absurd
 * pressure makes the fixed point oscillate between "refracted" and "cut off" forever).
 */
export function skyfieldRefractDeg(hTrueDeg: number, tempC: number, pressureMbar: number): number {
  let alt = hTrueDeg;
  for (let k = 0; k < SKYFIELD_MAX_ITERATIONS; k += 1) {
    const next = hTrueDeg + skyfieldRefractionDeg(alt, tempC, pressureMbar);
    const delta = Math.abs(next - alt);
    alt = next;
    if (delta <= SKYFIELD_TOLERANCE_DEG) {
      return alt;
    }
  }
  return alt;
}

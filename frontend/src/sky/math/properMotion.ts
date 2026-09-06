// Star propagation the frontend is allowed to do (brief l.41 (b) and (d), plan D82): linear
// proper motion with the backend-supplied SKYS velocity vector and first-order annual aberration
// with the backend-supplied observer velocity. Pure, dependency-free, allocation-free. The star
// shaders implement exactly these two steps in the same order (rules/sky-math.md); the CPU twin
// here feeds the debug hook and the parity tests against `skyfield_stars.json`.

import { load3, vec3 } from './typed';
import type { ReadonlyVec3, Vec3 } from './typed';
import { addScaled3, normalize3 } from './vec3';

/** Speed of light in au per day (rules/sky-math.md, IAU 2012 au). */
export const C_AU_PER_DAY = 173.1446;

// Scratch storage of the column readers (never allocated per call).
const scratchPm = vec3();

/**
 * `normalize(dir + pm * years)`: the SKYS rule `dir = p0 / |p0|`, `pm = (p1 - p0) / |p0|` per Julian
 * year (docs/api.md "SKYS v1"), so the sum is the barycentric direction `years` after the epoch.
 */
export function propagateStar(out: Vec3, dir: ReadonlyVec3, pm: ReadonlyVec3, years: number): Vec3 {
  return normalize3(out, addScaled3(out, dir, pm, years));
}

/**
 * First-order aberration `normalize(dir + v / c)` with the observer's barycentric velocity in
 * au/day (brief l.41 (d)): the same approximation for stars and bodies keeps one apparent frame.
 */
export function aberrate(out: Vec3, dir: ReadonlyVec3, velocityAuPerDay: ReadonlyVec3): Vec3 {
  return normalize3(out, addScaled3(out, dir, velocityAuPerDay, 1 / C_AU_PER_DAY));
}

/** Proper motion then aberration: the apparent direction the star shader computes. */
export function apparentStar(
  out: Vec3,
  dir: ReadonlyVec3,
  pm: ReadonlyVec3,
  years: number,
  velocityAuPerDay: ReadonlyVec3,
): Vec3 {
  return aberrate(out, propagateStar(out, dir, pm, years), velocityAuPerDay);
}

/** `propagateStar` reading row `index` of the 3-wide SKYS `dir` and `pm` columns. */
export function propagateStarAt(
  out: Vec3,
  dirs: ArrayLike<number>,
  pms: ArrayLike<number>,
  index: number,
  years: number,
): Vec3 {
  load3(out, dirs, 3 * index);
  load3(scratchPm, pms, 3 * index);
  return propagateStar(out, out, scratchPm, years);
}

/** `apparentStar` reading row `index` of the 3-wide SKYS `dir` and `pm` columns. */
export function apparentStarAt(
  out: Vec3,
  dirs: ArrayLike<number>,
  pms: ArrayLike<number>,
  index: number,
  years: number,
  velocityAuPerDay: ReadonlyVec3,
): Vec3 {
  return aberrate(out, propagateStarAt(out, dirs, pms, index, years), velocityAuPerDay);
}

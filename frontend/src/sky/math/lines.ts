// Polyline generators of the reference overlays (SKY-6, brief l.214, plan D84): horizon circle,
// altitude/azimuth grid, meridian, equatorial grid of date and ecliptic. Pure, dependency-free,
// allocation-free. Every generator writes UNIT vectors in whatever frame its axis is given (ENU
// for the static lines, the of-date or ICRF frame for the rotating ones, brought into ENU by
// `rotatePointsInPlace`); the engine scales by `SKY_RADIUS` and the frozen world matrix of
// `frames.ts` maps ENU to Babylon, so no axis swap happens here.

import { altAzToEnu } from './frames';
import { rotate } from './quaternion';
import { load3, store3, vec3 } from './typed';
import type { ReadonlyQuat, ReadonlyVec3 } from './typed';
import { cross3, normalize3, set3 } from './vec3';

export const EQUATORIAL_GRID_RA_STEP_DEG = 15;
export const EQUATORIAL_GRID_DEC_STEP_DEG = 15;
export const ALTAZ_GRID_AZ_STEP_DEG = 15;
export const ALTAZ_GRID_ALT_STEP_DEG = 10;
/** Segments per full circle (2 degrees each); a closed circle therefore has 181 points. */
export const CIRCLE_SEGMENTS = 180;

const DEG = Math.PI / 180;

// Scratch storage of the generators (never allocated per call).
const axisN = vec3();
const basisU = vec3();
const basisV = vec3();
const point = vec3();

/** Every polyline needs at least two points; `out` must hold `count` vectors from `offset`. */
function checkCapacity(out: Float32Array, offset: number, count: number): void {
  if (count < 2) {
    throw new RangeError(`a polyline needs at least 2 points, got ${String(count)}`);
  }
  if (offset < 0 || offset + 3 * count > out.length) {
    throw new RangeError(
      `${String(count)} points at offset ${String(offset)} exceed a buffer of ${String(out.length)} floats`,
    );
  }
}

/**
 * Orthonormal basis `(basisU, basisV)` of the plane perpendicular to `axis` (normalised into
 * `axisN`). The helper axis is the coordinate axis least aligned with `axis`, so the basis is
 * deterministic and never degenerate.
 */
function perpendicularBasis(axis: ReadonlyVec3): void {
  normalize3(axisN, axis);
  const ax = Math.abs(axisN[0]);
  const ay = Math.abs(axisN[1]);
  const az = Math.abs(axisN[2]);
  if (ax <= ay && ax <= az) {
    set3(basisU, 1, 0, 0);
  } else if (ay <= az) {
    set3(basisU, 0, 1, 0);
  } else {
    set3(basisU, 0, 0, 1);
  }
  cross3(basisU, axisN, basisU);
  normalize3(basisU, basisU);
  cross3(basisV, axisN, basisU);
}

/**
 * `count` points of the circle at `angleFromAxisDeg` from `axis` (a great circle at 90 degrees),
 * closed: the last point repeats the first. Returns the number of floats written (`3 * count`).
 */
export function smallCirclePoints(
  out: Float32Array,
  offset: number,
  axis: ReadonlyVec3,
  angleFromAxisDeg: number,
  count: number,
): number {
  checkCapacity(out, offset, count);
  perpendicularBasis(axis);
  const ca = Math.cos(angleFromAxisDeg * DEG);
  const sa = Math.sin(angleFromAxisDeg * DEG);
  const step = (2 * Math.PI) / (count - 1);
  for (let k = 0; k < count - 1; k += 1) {
    const c = sa * Math.cos(k * step);
    const s = sa * Math.sin(k * step);
    point[0] = ca * axisN[0] + c * basisU[0] + s * basisV[0];
    point[1] = ca * axisN[1] + c * basisU[1] + s * basisV[1];
    point[2] = ca * axisN[2] + c * basisU[2] + s * basisV[2];
    store3(out, offset + 3 * k, point);
  }
  load3(point, out, offset);
  store3(out, offset + 3 * (count - 1), point);
  return 3 * count;
}

/** The closed great circle perpendicular to `normal` (horizon: Up; meridian: East). */
export function greatCirclePoints(
  out: Float32Array,
  offset: number,
  normal: ReadonlyVec3,
  count: number,
): number {
  return smallCirclePoints(out, offset, normal, 90, count);
}

/**
 * `count` points of the vertical arc at azimuth `azDeg` from `altFromDeg` to `altToDeg` (an
 * altitude/azimuth grid line, meridian-like through the zenith). Returns the floats written.
 */
export function azimuthArcPoints(
  out: Float32Array,
  offset: number,
  azDeg: number,
  altFromDeg: number,
  altToDeg: number,
  count: number,
): number {
  checkCapacity(out, offset, count);
  const step = (altToDeg - altFromDeg) / (count - 1);
  for (let k = 0; k < count; k += 1) {
    altAzToEnu(point, altFromDeg + k * step, azDeg);
    store3(out, offset + 3 * k, point);
  }
  return 3 * count;
}

/** Rotate `count` consecutive vectors of `out` by `q` in place (of-date or ICRF -> ENU). */
export function rotatePointsInPlace(
  out: Float32Array,
  offset: number,
  count: number,
  q: ReadonlyQuat,
): void {
  for (let k = 0; k < count; k += 1) {
    const base = offset + 3 * k;
    load3(point, out, base);
    rotate(point, q, point);
    store3(out, base, point);
  }
}

// 3-vector algebra on fixed tuples (plan D71). Pure, dependency-free, allocation-free: every
// function writes into `out` (which may alias an input) and returns it.

import type { ReadonlyVec3, Vec3 } from './typed';

/** Arcseconds per radian (206264.806...). */
export const ARCSEC_PER_RAD = (180 * 3600) / Math.PI;

export function set3(out: Vec3, x: number, y: number, z: number): Vec3 {
  out[0] = x;
  out[1] = y;
  out[2] = z;
  return out;
}

export function copy3(out: Vec3, a: ReadonlyVec3): Vec3 {
  out[0] = a[0];
  out[1] = a[1];
  out[2] = a[2];
  return out;
}

export function add3(out: Vec3, a: ReadonlyVec3, b: ReadonlyVec3): Vec3 {
  out[0] = a[0] + b[0];
  out[1] = a[1] + b[1];
  out[2] = a[2] + b[2];
  return out;
}

export function sub3(out: Vec3, a: ReadonlyVec3, b: ReadonlyVec3): Vec3 {
  out[0] = a[0] - b[0];
  out[1] = a[1] - b[1];
  out[2] = a[2] - b[2];
  return out;
}

export function scale3(out: Vec3, a: ReadonlyVec3, s: number): Vec3 {
  out[0] = a[0] * s;
  out[1] = a[1] * s;
  out[2] = a[2] * s;
  return out;
}

/** `out = a + b * s`. */
export function addScaled3(out: Vec3, a: ReadonlyVec3, b: ReadonlyVec3, s: number): Vec3 {
  out[0] = a[0] + b[0] * s;
  out[1] = a[1] + b[1] * s;
  out[2] = a[2] + b[2] * s;
  return out;
}

export function dot3(a: ReadonlyVec3, b: ReadonlyVec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** `out = a x b`; inputs are read before `out` is written, so aliasing is safe. */
export function cross3(out: Vec3, a: ReadonlyVec3, b: ReadonlyVec3): Vec3 {
  const x = a[1] * b[2] - a[2] * b[1];
  const y = a[2] * b[0] - a[0] * b[2];
  const z = a[0] * b[1] - a[1] * b[0];
  out[0] = x;
  out[1] = y;
  out[2] = z;
  return out;
}

/**
 * `|a|` as a plain square root (plan D144): `Math.hypot` guards against overflow and underflow
 * of the squares, which unit and au-scale vectors never approach, and its varargs handling
 * allocated 0.9 MB over six seconds in the M6 heap table (`normalize3` runs per body per frame
 * and per constellation endpoint per overlay tick). `angleBetween3` follows the same rule for
 * `|a x b|` (the heap table named `length3` alone; the change there is covered at the same
 * tolerances and recorded with it).
 */
export function length3(a: ReadonlyVec3): number {
  return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
}

/** `out = a / |a|`; throws `RangeError` for a zero (or non-finite) vector. */
export function normalize3(out: Vec3, a: ReadonlyVec3): Vec3 {
  const len = length3(a);
  if (!(len > 0) || !Number.isFinite(len)) {
    throw new RangeError('cannot normalize a zero or non-finite vector');
  }
  return scale3(out, a, 1 / len);
}

/**
 * Angle between two vectors in radians through `atan2(|a x b|, a . b)`, which keeps its precision
 * for nearly parallel unit vectors where `acos` saturates at about 0.3 arcsec (plan D71).
 */
export function angleBetween3(a: ReadonlyVec3, b: ReadonlyVec3): number {
  const cx = a[1] * b[2] - a[2] * b[1];
  const cy = a[2] * b[0] - a[0] * b[2];
  const cz = a[0] * b[1] - a[1] * b[0];
  return Math.atan2(Math.sqrt(cx * cx + cy * cy + cz * cz), dot3(a, b));
}

/** Angle between two vectors in arcseconds. */
export function arcsecBetween3(a: ReadonlyVec3, b: ReadonlyVec3): number {
  return angleBetween3(a, b) * ARCSEC_PER_RAD;
}

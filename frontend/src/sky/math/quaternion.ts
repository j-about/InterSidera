// Unit quaternions `[x, y, z, w]` in the Hamilton convention, `v' = q v q^-1`, exactly as the
// backend serialises `horizon.q` and `equinox_of_date.q` (brief l.57, `astro/quaternions.py`).
// Pure, dependency-free, allocation-free (plan D71, D74).

import type { Quat, ReadonlyQuat, ReadonlyVec3, Vec3 } from './typed';

/** Below this `1 - |a . b|` the slerp arc is treated as zero and a normalised lerp is used. */
const SLERP_NLERP_THRESHOLD = 1e-10;

export function setQ(out: Quat, x: number, y: number, z: number, w: number): Quat {
  out[0] = x;
  out[1] = y;
  out[2] = z;
  out[3] = w;
  return out;
}

export function copyQ(out: Quat, a: ReadonlyQuat): Quat {
  out[0] = a[0];
  out[1] = a[1];
  out[2] = a[2];
  out[3] = a[3];
  return out;
}

export function dotQ(a: ReadonlyQuat, b: ReadonlyQuat): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
}

export function lengthQ(a: ReadonlyQuat): number {
  return Math.hypot(a[0], a[1], a[2], a[3]);
}

/** `out = a / |a|`; throws `RangeError` for a zero or non-finite quaternion. */
export function normalizeQ(out: Quat, a: ReadonlyQuat): Quat {
  const len = lengthQ(a);
  if (!(len > 0) || !Number.isFinite(len)) {
    throw new RangeError('cannot normalize a zero or non-finite quaternion');
  }
  const s = 1 / len;
  return setQ(out, a[0] * s, a[1] * s, a[2] * s, a[3] * s);
}

/** The inverse rotation of a unit quaternion. */
export function conjugateQ(out: Quat, a: ReadonlyQuat): Quat {
  return setQ(out, -a[0], -a[1], -a[2], a[3]);
}

/**
 * Hamilton product `out = a * b`: rotating by `a * b` applies `b` first, then `a`
 * (`(a * b) v (a * b)^-1 = a (b v b^-1) a^-1`). Aliasing-safe.
 */
export function multiplyQ(out: Quat, a: ReadonlyQuat, b: ReadonlyQuat): Quat {
  const ax = a[0];
  const ay = a[1];
  const az = a[2];
  const aw = a[3];
  const bx = b[0];
  const by = b[1];
  const bz = b[2];
  const bw = b[3];
  return setQ(
    out,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  );
}

/**
 * Rotate `v` by the unit quaternion `q`: `t = 2 (u x v)`, `out = v + w t + u x t` with
 * `u = q.xyz`. Aliasing-safe (`out` may be `v`).
 */
export function rotate(out: Vec3, q: ReadonlyQuat, v: ReadonlyVec3): Vec3 {
  const ux = q[0];
  const uy = q[1];
  const uz = q[2];
  const w = q[3];
  const vx = v[0];
  const vy = v[1];
  const vz = v[2];
  const tx = 2 * (uy * vz - uz * vy);
  const ty = 2 * (uz * vx - ux * vz);
  const tz = 2 * (ux * vy - uy * vx);
  out[0] = vx + w * tx + (uy * tz - uz * ty);
  out[1] = vy + w * ty + (uz * tx - ux * tz);
  out[2] = vz + w * tz + (ux * ty - uy * tx);
  return out;
}

/** Rotate `v` by the inverse of `q` (`q^-1 v q`). */
export function rotateInverse(out: Vec3, q: ReadonlyQuat, v: ReadonlyVec3): Vec3 {
  const ux = -q[0];
  const uy = -q[1];
  const uz = -q[2];
  const w = q[3];
  const vx = v[0];
  const vy = v[1];
  const vz = v[2];
  const tx = 2 * (uy * vz - uz * vy);
  const ty = 2 * (uz * vx - ux * vz);
  const tz = 2 * (ux * vy - uy * vx);
  out[0] = vx + w * tx + (uy * tz - uz * ty);
  out[1] = vy + w * ty + (uz * tx - ux * tz);
  out[2] = vz + w * tz + (ux * ty - uy * tx);
  return out;
}

/**
 * Spherical linear interpolation from `a` (t = 0) to `b` (t = 1). Backend samples are
 * sign-continuous (brief l.58) so the short arc is already the one between them; a negative dot
 * product is still handled defensively by negating `b`. `t` may leave `[0, 1]` (constant-rate
 * extrapolation while a request is in flight, brief l.69). Nearly equal inputs fall back to a
 * normalised lerp. The result is renormalised.
 */
export function slerp(out: Quat, a: ReadonlyQuat, b: ReadonlyQuat, t: number): Quat {
  let bx = b[0];
  let by = b[1];
  let bz = b[2];
  let bw = b[3];
  let d = dotQ(a, b);
  if (d < 0) {
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
    d = -d;
  }
  let w0: number;
  let w1: number;
  if (d > 1 - SLERP_NLERP_THRESHOLD) {
    w0 = 1 - t;
    w1 = t;
  } else {
    // D71 idiom: the arc angle from atan2(|b - (a.b) a|, a.b), the norm of the part of `b`
    // orthogonal to `a` being sin(theta) for unit inputs, never acos of the dot product.
    const s = Math.hypot(bx - d * a[0], by - d * a[1], bz - d * a[2], bw - d * a[3]);
    const theta = Math.atan2(s, d);
    w0 = Math.sin((1 - t) * theta) / s;
    w1 = Math.sin(t * theta) / s;
  }
  setQ(out, w0 * a[0] + w1 * bx, w0 * a[1] + w1 * by, w0 * a[2] + w1 * bz, w0 * a[3] + w1 * bw);
  return normalizeQ(out, out);
}

/**
 * Angle in radians between the rotations `a` and `b` (the rotation `a * b^-1`), independent of
 * the quaternion signs and accurate for tiny angles (`atan2`, not `acos`).
 */
export function rotationAngle(a: ReadonlyQuat, b: ReadonlyQuat): number {
  // r = a * conj(b)
  const ax = a[0];
  const ay = a[1];
  const az = a[2];
  const aw = a[3];
  const bx = -b[0];
  const by = -b[1];
  const bz = -b[2];
  const bw = b[3];
  const rx = aw * bx + ax * bw + ay * bz - az * by;
  const ry = aw * by - ax * bz + ay * bw + az * bx;
  const rz = aw * bz + ax * by - ay * bx + az * bw;
  const rw = aw * bw - ax * bx - ay * by - az * bz;
  return 2 * Math.atan2(Math.hypot(rx, ry, rz), Math.abs(rw));
}

/** Unit quaternion for a rotation of `angle` radians about the unit `axis` (tests, grids). */
export function fromAxisAngle(out: Quat, axis: ReadonlyVec3, angle: number): Quat {
  const half = angle / 2;
  const s = Math.sin(half);
  return setQ(out, axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(half));
}

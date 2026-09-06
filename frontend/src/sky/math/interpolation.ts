// Interpolation of `/sky/frame` samples on the uniform grid `tt_i = tt0 + i * stepD`,
// `stepD = step_s / 86400` (plan D74, brief l.67-69). Pure, dependency-free, allocation-free.
//
// The engine evaluates one window per animation frame: the segment index comes from a division
// (no search), body directions and the scalar channels use cubic Hermite with Catmull-Rom
// tangents (one-sided at the window ends and next to a `NaN` sample), the horizon and equinox
// quaternions are slerped, `sun_dir` and the observer velocity are linear, and local sidereal
// time is interpolated on the 24 h circle. While a request is in flight the window is continued
// linearly from its two boundary samples (brief l.69). A snapshot window (`n = 1`, brief l.70)
// holds sample 0 everywhere. `mag: null` is stored as `NaN` and propagates through the Hermite
// arithmetic, so a segment with an unknown endpoint evaluates to `NaN` (plan D74).

import { normalizeQ, slerp } from './quaternion';
import { at, load3, load4, quat, vec3 } from './typed';
import type { Quat, Vec3 } from './typed';
import { normalize3 } from './vec3';

// Scratch storage of the synchronous kernels below (never allocated per call).
const scratchV = vec3();
const scratchQ = quat();

/** TT Julian Date of sample `i` of a window. */
export function sampleTt(tt0: number, stepD: number, i: number): number {
  return tt0 + i * stepD;
}

/**
 * Index `i` of the segment `[tt_i, tt_(i+1)]` holding `tt`, clamped to `0..n-2` so times beyond
 * the window select the boundary segment (`0` when `n == 1`).
 */
export function segmentIndex(tt0: number, stepD: number, n: number, tt: number): number {
  if (n < 2) {
    return 0;
  }
  const i = Math.floor((tt - tt0) / stepD);
  return Math.max(0, Math.min(n - 2, i));
}

/** Position of `tt` inside segment `i`: 0 at `tt_i`, 1 at `tt_(i+1)`, outside `[0, 1]` beyond it. */
export function segmentFraction(tt0: number, stepD: number, i: number, tt: number): number {
  return (tt - tt0) / stepD - i;
}

/** Cubic Hermite on `[0, 1]` with the tangents `m0`, `m1` expressed per segment. */
export function hermite(y0: number, y1: number, m0: number, m1: number, u: number): number {
  const u2 = u * u;
  const u3 = u2 * u;
  return (
    (2 * u3 - 3 * u2 + 1) * y0 + (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) * y1 + (u3 - u2) * m1
  );
}

/**
 * Catmull-Rom tangent (per segment) of the channel stored at `values[k * stride + offset]` for
 * sample `k`: the centred difference `(y_(i+1) - y_(i-1)) / 2` inside the window, one-sided at
 * `i == 0` and `i == n - 1`, and one-sided next to a `NaN` neighbour (an unknown magnitude must
 * not poison the tangent of its finite neighbours). Zero when no finite neighbour exists.
 */
export function catmullRomTangent(
  values: ArrayLike<number>,
  n: number,
  i: number,
  stride: number,
  offset: number,
): number {
  const y = at(values, i * stride + offset);
  const prev = i > 0 ? at(values, (i - 1) * stride + offset) : NaN;
  const next = i < n - 1 ? at(values, (i + 1) * stride + offset) : NaN;
  const hasPrev = Number.isFinite(prev);
  const hasNext = Number.isFinite(next);
  if (hasPrev && hasNext) {
    return (next - prev) / 2;
  }
  if (hasNext) {
    return next - y;
  }
  if (hasPrev) {
    return y - prev;
  }
  return 0;
}

/**
 * Hermite value of a scalar channel in segment `i` at fraction `u`. `NaN` when either endpoint is
 * `NaN` (the arithmetic propagates it); a snapshot window returns its only sample.
 */
export function interpolateScalar(
  values: ArrayLike<number>,
  n: number,
  i: number,
  u: number,
  stride = 1,
  offset = 0,
): number {
  const y0 = at(values, i * stride + offset);
  if (n < 2) {
    return y0;
  }
  const y1 = at(values, (i + 1) * stride + offset);
  return hermite(
    y0,
    y1,
    catmullRomTangent(values, n, i, stride, offset),
    catmullRomTangent(values, n, i + 1, stride, offset),
    u,
  );
}

/** Component-wise Hermite of unit vectors stored `[x0, y0, z0, x1, ...]`, renormalised. */
export function interpolateDir(
  out: Vec3,
  dirs: ArrayLike<number>,
  n: number,
  i: number,
  u: number,
): Vec3 {
  out[0] = interpolateScalar(dirs, n, i, u, 3, 0);
  out[1] = interpolateScalar(dirs, n, i, u, 3, 1);
  out[2] = interpolateScalar(dirs, n, i, u, 3, 2);
  return normalize3(out, out);
}

/**
 * Linear interpolation of a 3-vector channel (`sun_dir` with `normalize`, the observer velocity
 * without: a velocity is not a direction, plan D74).
 */
export function interpolateVec3(
  out: Vec3,
  values: ArrayLike<number>,
  n: number,
  i: number,
  u: number,
  normalize: boolean,
): Vec3 {
  load3(out, values, 3 * i);
  if (n >= 2) {
    load3(scratchV, values, 3 * (i + 1));
    out[0] += (scratchV[0] - out[0]) * u;
    out[1] += (scratchV[1] - out[1]) * u;
    out[2] += (scratchV[2] - out[2]) * u;
  }
  return normalize ? normalize3(out, out) : out;
}

/**
 * Slerp between the quaternions of samples `i` and `i + 1` (stored `[x, y, z, w]` per sample).
 * Both samples are renormalised first: the API rounds them to nine decimals (docs/api.md
 * "Rounding"), so their norm is only approximately 1.
 */
export function slerpAt(out: Quat, qs: ArrayLike<number>, n: number, i: number, u: number): Quat {
  load4(out, qs, 4 * i);
  normalizeQ(out, out);
  if (n < 2) {
    return out;
  }
  load4(scratchQ, qs, 4 * (i + 1));
  normalizeQ(scratchQ, scratchQ);
  return slerp(out, out, scratchQ, u);
}

/** Wrap hours into `[0, 24)`; `24` and `-0` become `0`. */
function wrapHours(h: number): number {
  const w = h % 24;
  if (w < 0) {
    const p = w + 24;
    return p >= 24 ? 0 : p;
  }
  return w;
}

/**
 * Local apparent sidereal time between samples `i` and `i + 1` on the 24 h circle: the difference
 * is unwrapped into `[-12, 12)` before the linear step, so `23.9 -> 0.1` passes through `0`
 * (TIME-1, brief l.201).
 */
export function interpolateLstHours(
  lst: ArrayLike<number>,
  n: number,
  i: number,
  u: number,
): number {
  const a = at(lst, i);
  if (n < 2) {
    return wrapHours(a);
  }
  let d = at(lst, i + 1) - a;
  d -= 24 * Math.floor((d + 12) / 24);
  return wrapHours(a + d * u);
}

/**
 * The boundary segment used to continue a window: the first one before `tt0`, the last one
 * otherwise (a `tt` still inside the window continues from its last two samples).
 */
function boundarySegment(n: number, tt0: number, tt: number): number {
  return tt < tt0 ? 0 : n - 2;
}

/** Linear continuation of a scalar channel from the two boundary samples (brief l.69). */
export function extrapolateScalar(
  values: ArrayLike<number>,
  n: number,
  stepD: number,
  tt0: number,
  tt: number,
  stride = 1,
  offset = 0,
): number {
  const y0 = at(values, offset);
  if (n < 2) {
    return y0;
  }
  const i = boundarySegment(n, tt0, tt);
  const u = segmentFraction(tt0, stepD, i, tt);
  const a = at(values, i * stride + offset);
  const b = at(values, (i + 1) * stride + offset);
  return a + (b - a) * u;
}

/** Linear continuation of unit vectors from the two boundary samples, renormalised. */
export function extrapolateDir(
  out: Vec3,
  dirs: ArrayLike<number>,
  n: number,
  stepD: number,
  tt0: number,
  tt: number,
): Vec3 {
  out[0] = extrapolateScalar(dirs, n, stepD, tt0, tt, 3, 0);
  out[1] = extrapolateScalar(dirs, n, stepD, tt0, tt, 3, 1);
  out[2] = extrapolateScalar(dirs, n, stepD, tt0, tt, 3, 2);
  return normalize3(out, out);
}

/**
 * Constant-rate continuation of a quaternion series: slerp between the two boundary samples with
 * `t` outside `[0, 1]`, which extends the rotation along the same geodesic (renormalised).
 */
export function extrapolateQuat(
  out: Quat,
  qs: ArrayLike<number>,
  n: number,
  stepD: number,
  tt0: number,
  tt: number,
): Quat {
  if (n < 2) {
    return slerpAt(out, qs, n, 0, 0);
  }
  const i = boundarySegment(n, tt0, tt);
  return slerpAt(out, qs, n, i, segmentFraction(tt0, stepD, i, tt));
}

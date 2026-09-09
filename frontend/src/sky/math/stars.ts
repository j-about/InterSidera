// Star appearance rules (SKY-1, brief l.209, plan D82): the magnitude limit that follows the
// field of view, the pixel size and brightness of a star from its magnitude, and its colour from
// B-V. Pure, dependency-free. The star shaders mirror `starPixelRadius`, `starBrightness` and
// the B-V ramp with the constants exported here, so the CPU twin of the debug hook and the GPU
// agree to the pixel.

import type { Vec3 } from './typed';

/** Naked-eye limit shown at a 90 degree (or wider) field of view (SKY-1 "about 6.5 at 90 deg"). */
export const WIDE_FIELD_MAG_LIMIT = 6.5;
/** Field of view at and above which the limit is `WIDE_FIELD_MAG_LIMIT` (degrees). */
export const WIDE_FIELD_FOV_DEG = 90;
/** Field of view at and below which the limit is the catalog limit (degrees). */
export const NARROW_FIELD_FOV_DEG = 1;

/** Pixel radius of a star at `STAR_REFERENCE_MAG` in a 90 degree field (CSS pixels). */
export const STAR_SIZE_BASE_PX = 1;
/** Radius gained per magnitude of brightness (CSS pixels per magnitude). */
export const STAR_SIZE_PER_MAG = 0.55;
/** A star is never drawn smaller than this radius: it must stay visible (CSS pixels). */
export const STAR_SIZE_MIN_PX = 1;
/** Nor larger: Sirius stays a disc, not a blob (CSS pixels). */
export const STAR_SIZE_MAX_PX = 12;
/** The magnitude drawn at `STAR_SIZE_BASE_PX` in a 90 degree field: the naked-eye limit. */
export const STAR_REFERENCE_MAG = WIDE_FIELD_MAG_LIMIT;
/**
 * Zooming from 90 to 1 degree shifts the reference magnitude by this much on the same log scale
 * as the limit, so the stars that become visible are drawn at the size of the stars they replace.
 */
export const STAR_SIZE_ZOOM_MAG = 3;

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** 0 at (or beyond) 90 degrees, 1 at (or below) 1 degree, logarithmic in between (shared with `dso.ts`). */
export function zoomFraction(fovDeg: number): number {
  return clamp01(Math.log(WIDE_FIELD_FOV_DEG / fovDeg) / Math.log(WIDE_FIELD_FOV_DEG));
}

/**
 * Magnitude limit following the field of view (SKY-1): 6.5 at 90 degrees and wider, rising on a
 * log scale to `catalogLimit` (the `/meta` `magnitude_limit`) at 1 degree and narrower.
 */
export function magnitudeLimitForFov(fovDeg: number, catalogLimit: number): number {
  return WIDE_FIELD_MAG_LIMIT + (catalogLimit - WIDE_FIELD_MAG_LIMIT) * zoomFraction(fovDeg);
}

/**
 * Pixel radius of a star (CSS pixels), decreasing with magnitude and clamped to
 * `[STAR_SIZE_MIN_PX, STAR_SIZE_MAX_PX]`:
 * `base + perMag * (referenceMag + zoomMag * zoom(fov) - mag)`.
 */
export function starPixelRadius(mag: number, fovDeg: number): number {
  const reference = STAR_REFERENCE_MAG + STAR_SIZE_ZOOM_MAG * zoomFraction(fovDeg);
  const radius = STAR_SIZE_BASE_PX + STAR_SIZE_PER_MAG * (reference - mag);
  return Math.max(STAR_SIZE_MIN_PX, Math.min(STAR_SIZE_MAX_PX, radius));
}

/** Relative brightness `10^(-0.4 (mag - referenceMag))` clamped to `[0, 1]` (Pogson's ratio). */
export function starBrightness(mag: number, referenceMag: number): number {
  return clamp01(Math.pow(10, -0.4 * (mag - referenceMag)));
}

/** One colour stop `[bv, r, g, b]` on a 0..1 scale. */
export type BvColorStop = readonly [number, number, number, number];

// The two end stops are named so the lookup below needs no `undefined` guard (D71 idiom).
const STOP_O: BvColorStop = [-0.33, 155 / 255, 176 / 255, 255 / 255];
const STOP_M: BvColorStop = [1.4, 255 / 255, 204 / 255, 111 / 255];

/**
 * Piecewise-linear B-V -> sRGB stops (blackbody-like ramp from O stars at -0.33 to M stars at
 * 1.4). Values outside the range take the nearest end stop. An unknown B-V (SKYS sentinel 32767
 * millimag) is replaced by 0.65 by the caller.
 */
export const BV_COLOR_STOPS: readonly BvColorStop[] = [
  STOP_O,
  [0.0, 202 / 255, 216 / 255, 255 / 255],
  [0.3, 248 / 255, 247 / 255, 255 / 255],
  [0.6, 255 / 255, 244 / 255, 234 / 255],
  [1.0, 255 / 255, 210 / 255, 161 / 255],
  STOP_M,
];

/** Linear colour between the two stops around `bvMag`, written into `out` as `[r, g, b]`. */
export function bvToRgb(out: Vec3, bvMag: number): Vec3 {
  let lo = STOP_O;
  let hi = STOP_M;
  let hiFound = false;
  for (const stop of BV_COLOR_STOPS) {
    if (stop[0] <= bvMag) {
      lo = stop;
    }
    if (!hiFound && stop[0] >= bvMag) {
      hi = stop;
      hiFound = true;
    }
  }
  const span = hi[0] - lo[0];
  const t = span > 0 ? (bvMag - lo[0]) / span : 0;
  out[0] = lo[1] + (hi[1] - lo[1]) * t;
  out[1] = lo[2] + (hi[2] - lo[2]) * t;
  out[2] = lo[3] + (hi[3] - lo[3]) * t;
  return out;
}

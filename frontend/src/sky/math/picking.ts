// Object picking (INFO-1, brief l.230, plan D106): the tap tolerance scaled by the field of view,
// the ICRF cone that pre-filters the star catalog, the magnitude-sorted row limit and the
// nearest-candidate accumulator with its kind priority. Pure, dependency-free, allocation-free.
// The engine turns a tap into an ICRF direction, walks the candidates through these helpers and
// refines the survivors on screen with `frames.ts::directionToScreen`.

import { DEG } from './frames';
import { at } from './typed';
import type { ReadonlyVec3 } from './typed';

/** Tap tolerance in CSS pixels (INFO-1 "a tolerance scaled by the field of view"). */
export const PICK_TOLERANCE_PX = 24;
/** The cone pre-filter is widened by this much (degrees): refraction moves a star up to 34'. */
export const PICK_CONE_MARGIN_DEG = 0.6;
/** Candidates closer than this (CSS pixels) tie and the kind priority decides. */
export const PICK_TIE_PX = 3;

export type PickKind = 'body' | 'minor' | 'dso' | 'star';

/** Lower wins a tie: a body over a minor body over a deep-sky object over a star. */
export function pickPriority(kind: PickKind): number {
  switch (kind) {
    case 'body':
      return 0;
    case 'minor':
      return 1;
    case 'dso':
      return 2;
    case 'star':
      return 3;
  }
}

/** The best candidate so far; `id` is `null` until one lands within the tolerance (`kind` is then meaningless). */
export interface PickBest {
  id: string | null;
  kind: PickKind;
  distPx: number;
  tolPx: number;
}

export function createPickBest(): PickBest {
  return { id: null, kind: 'star', distPx: Infinity, tolPx: PICK_TOLERANCE_PX };
}

/** Forget the previous pick and set the tolerance of the next one. */
export function resetPickBest(best: PickBest, tolPx: number): void {
  best.id = null;
  best.kind = 'star';
  best.distPx = Infinity;
  best.tolPx = tolPx;
}

/** The tolerance as an angle: `tolPx` CSS pixels at the centre of a `fovDeg` field `heightPx` high. */
export function pickToleranceDeg(tolPx: number, fovDeg: number, heightPx: number): number {
  return (tolPx * fovDeg) / heightPx;
}

/** Cosine of the pre-filter cone half-angle (`tolDeg` plus the refraction margin). */
export function coneCosine(tolDeg: number): number {
  return Math.cos((tolDeg + PICK_CONE_MARGIN_DEG) * DEG);
}

/**
 * Number of leading rows of a magnitude-sorted SKYS `mag` column (millimagnitudes) at or brighter
 * than `magLimit`: the first index whose magnitude exceeds the limit, by binary search.
 */
export function starRowLimit(mags: ArrayLike<number>, count: number, magLimit: number): number {
  const limitMillimag = magLimit * 1000;
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (at(mags, mid) <= limitMillimag) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/**
 * Cheap cone test on the propagated (unnormalised) star direction `dir + pm years` of row `row`:
 * `dot(d, tap) >= cosCone |d|`. Six multiply-adds and one square root per star.
 */
export function starInCone(
  dirs: ArrayLike<number>,
  pms: ArrayLike<number>,
  row: number,
  years: number,
  tap: ReadonlyVec3,
  cosCone: number,
): boolean {
  const o = 3 * row;
  const x = at(dirs, o) + at(pms, o) * years;
  const y = at(dirs, o + 1) + at(pms, o + 1) * years;
  const z = at(dirs, o + 2) + at(pms, o + 2) * years;
  const dot = x * tap[0] + y * tap[1] + z * tap[2];
  return dot >= cosCone * Math.sqrt(x * x + y * y + z * z);
}

/** Cone test on a unit direction. */
export function inCone(d: ReadonlyVec3, tap: ReadonlyVec3, cosCone: number): boolean {
  return d[0] * tap[0] + d[1] * tap[1] + d[2] * tap[2] >= cosCone;
}

/**
 * Offer a candidate at screen distance `distPx` from the tap. It becomes the best when it lies
 * within the tolerance and is nearer than the current best by more than `PICK_TIE_PX`, or ties
 * with it and has the higher kind priority. Returns whether it was taken.
 */
export function nearestWithin(best: PickBest, id: string, kind: PickKind, distPx: number): boolean {
  if (!(distPx <= best.tolPx)) {
    return false;
  }
  if (best.id === null) {
    best.id = id;
    best.kind = kind;
    best.distPx = distPx;
    return true;
  }
  const delta = distPx - best.distPx;
  const nearer = delta < -PICK_TIE_PX;
  const tied = Math.abs(delta) <= PICK_TIE_PX && pickPriority(kind) < pickPriority(best.kind);
  if (nearer || tied) {
    best.id = id;
    best.kind = kind;
    best.distPx = distPx;
    return true;
  }
  return false;
}

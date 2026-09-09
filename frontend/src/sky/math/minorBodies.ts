// Minor-body rules (SKY-4, brief l.212, plan D102): the request list composed from the user's
// pins and the server defaults, the disc size from the apparent magnitude and the direction of a
// comet's tail. Pure, dependency-free; only `composeMinorRequest` allocates (its result), and it
// runs on a store change, never per frame.

import type { ReadonlyVec3, Vec3 } from './typed';
import { dot3 } from './vec3';

/** Disc radius bounds (CSS pixels): `clamp(1 + 0.5 (9 - mag), 1.5, 4)`. */
export const MINOR_RADIUS_MIN_PX = 1.5;
export const MINOR_RADIUS_MAX_PX = 4;
export const MINOR_RADIUS_REFERENCE_MAG = 9;
export const MINOR_RADIUS_PER_MAG = 0.5;
/** Length of a comet tail on screen (CSS pixels). */
export const COMET_TAIL_PX = 30;
/** Below this squared length the tail direction is undefined (body at or opposite the Sun). */
const TANGENT_EPSILON = 1e-12;

/**
 * Unit tangent at unit direction `d` pointing away from the Sun direction `s` (both in the same
 * frame): the component of `-s` perpendicular to `d`, `(s . d) d - s`, normalised into `out`.
 * `false` (and `out` untouched) when the body sits at or exactly opposite the Sun.
 */
export function antisolarTangent(out: Vec3, d: ReadonlyVec3, s: ReadonlyVec3): boolean {
  const k = dot3(s, d);
  const x = k * d[0] - s[0];
  const y = k * d[1] - s[1];
  const z = k * d[2] - s[2];
  const len2 = x * x + y * y + z * z;
  if (len2 < TANGENT_EPSILON) {
    return false;
  }
  const inv = 1 / Math.sqrt(len2);
  out[0] = x * inv;
  out[1] = y * inv;
  out[2] = z * inv;
  return true;
}

/** Disc radius of a minor body from its apparent magnitude; an unknown magnitude draws the minimum. */
export function minorPixelRadius(mag: number): number {
  if (!Number.isFinite(mag)) {
    return MINOR_RADIUS_MIN_PX;
  }
  const radius = 1 + MINOR_RADIUS_PER_MAG * (MINOR_RADIUS_REFERENCE_MAG - mag);
  return Math.max(MINOR_RADIUS_MIN_PX, Math.min(MINOR_RADIUS_MAX_PX, radius));
}

function sortedUnique(ids: readonly string[]): string[] {
  return Array.from(new Set(ids)).sort();
}

/**
 * The `minor` list of a `/sky/frame` request: the pinned ids and the first `shown` defaults,
 * de-duplicated and sorted (identical skies share cache keys). Beyond `cap` the pins come first
 * and the defaults fill what is left. An absent defaults list (`null`) contributes nothing.
 */
export function composeMinorRequest(
  pins: readonly string[],
  defaults: readonly string[] | null,
  shown: number,
  cap: number,
): string[] {
  const pinned = sortedUnique(pins);
  const wanted = defaults === null ? [] : defaults.slice(0, Math.max(0, shown));
  const all = sortedUnique([...pinned, ...wanted]);
  if (all.length <= cap) {
    return all;
  }
  const result = pinned.slice(0, cap);
  const taken = new Set(result);
  for (const id of wanted) {
    if (result.length >= cap) {
      break;
    }
    if (!taken.has(id)) {
      taken.add(id);
      result.push(id);
    }
  }
  return result.sort();
}

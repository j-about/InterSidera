// The CPU twin of the direction pipeline the shaders run (plan D94; brief l.41, sky-math rule
// "change one, change all"): a catalog direction gets first-order aberration with the backend
// observer velocity (allowed on catalog directions, l.41 (d)), the horizon rotation and, on Earth
// with refraction on, the D73 altitude correction. Labels, constellation lines, picking, follow
// mode, the selection marker, the readout and the debug hook all read directions from here, so
// the overlay and the picture cannot disagree. Pure, dependency-free, allocation-free.

import { altAzToEnu, enuToAltAz } from './frames';
import type { AltAz } from './frames';
import { aberrate, apparentStarAt } from './properMotion';
import { rotate } from './quaternion';
import { apparentAltitudeDeg } from './refraction';
import type { ReadonlyQuat, ReadonlyVec3, Vec3 } from './typed';
import { cross3, dot3 } from './vec3';

/** The `dir` and `pm` columns of a SKYS catalog (`StarColumns` satisfies it structurally). */
export interface StarDirectionColumns {
  dir: ArrayLike<number>;
  pm: ArrayLike<number>;
}

const UP: ReadonlyVec3 = [0, 0, 1];
/** Below this squared length the projected camera axis is degenerate (the object lies on it). */
export const BILLBOARD_EPSILON = 1e-12;

// Scratch storage of the kernels (never allocated per call).
const scratchAltAz: AltAz = { alt: 0, az: 0 };

/**
 * An apparent ICRF direction into ENU: the horizon rotation, then, when refraction applies, the
 * D73 correction on the altitude with the azimuth kept (the rule the star shaders implement).
 * `out` may alias `d`.
 */
export function enuFromApparentIcrf(
  out: Vec3,
  d: ReadonlyVec3,
  q: ReadonlyQuat,
  refractionOn: boolean,
  factor: number,
): Vec3 {
  rotate(out, q, d);
  if (!refractionOn) {
    return out;
  }
  enuToAltAz(scratchAltAz, out[0], out[1], out[2]);
  return altAzToEnu(out, apparentAltitudeDeg(scratchAltAz.alt, factor), scratchAltAz.az);
}

/**
 * A catalog direction without proper motion (a deep-sky object, a constellation label point):
 * aberration, then the tail above. The DSO shader applies exactly these steps.
 */
export function apparentCatalogEnu(
  out: Vec3,
  dirIcrf: ReadonlyVec3,
  observerVelocity: ReadonlyVec3,
  q: ReadonlyQuat,
  refractionOn: boolean,
  factor: number,
): Vec3 {
  aberrate(out, dirIcrf, observerVelocity);
  return enuFromApparentIcrf(out, out, q, refractionOn, factor);
}

/**
 * Row `row` of a SKYS catalog as the star shader draws it: proper motion, aberration, the horizon
 * rotation and the optional refraction (`properMotion.ts::apparentStarAt` plus the tail).
 */
export function apparentStarEnuAt(
  out: Vec3,
  columns: StarDirectionColumns,
  row: number,
  years: number,
  observerVelocity: ReadonlyVec3,
  q: ReadonlyQuat,
  refractionOn: boolean,
  factor: number,
): Vec3 {
  apparentStarAt(out, columns.dir, columns.pm, row, years, observerVelocity);
  return enuFromApparentIcrf(out, out, q, refractionOn, factor);
}

/**
 * Orthonormal billboard basis of an object at unit ENU direction `dir`, into `outRight` and
 * `outUp`. A quad expanded in screen pixels needs its own screen-aligned basis at the object's
 * image: screen right there is the camera's right axis projected on the object's tangent plane,
 * `cameraRight - (cameraRight . dir) dir`, and up is `(-dir) x right` so that `right x up` points
 * to the viewer. Reusing the camera's own axes for every object would skew the terminator of a
 * body (about 2 degrees at 25 degrees off-axis in a 60 degree field) and the position angle of a
 * galaxy. When the object lies on the camera's right axis (90 degrees off-screen, still uploaded
 * as a hidden-by-clipping quad) screen right is undefined and the horizontal direction to the
 * object's right, `dir x Up`, takes over; a horizontal `dir` never degenerates it.
 */
export function billboardBasis(
  outRight: Vec3,
  outUp: Vec3,
  dir: ReadonlyVec3,
  cameraRight: ReadonlyVec3,
): void {
  const along = dot3(cameraRight, dir);
  outRight[0] = cameraRight[0] - along * dir[0];
  outRight[1] = cameraRight[1] - along * dir[1];
  outRight[2] = cameraRight[2] - along * dir[2];
  let len2 = dot3(outRight, outRight);
  if (len2 < BILLBOARD_EPSILON) {
    cross3(outRight, dir, UP);
    len2 = dot3(outRight, outRight);
  }
  const inv = 1 / Math.sqrt(len2);
  outRight[0] *= inv;
  outRight[1] *= inv;
  outRight[2] *= inv;
  // up = (-dir) x right
  outUp[0] = -(dir[1] * outRight[2] - dir[2] * outRight[1]);
  outUp[1] = -(dir[2] * outRight[0] - dir[0] * outRight[2]);
  outUp[2] = -(dir[0] * outRight[1] - dir[1] * outRight[0]);
}

/**
 * Angle in radians of a tangent-plane vector `v` in the billboard basis, counter-clockwise from
 * screen right toward screen up (`atan2(v . up, v . right)`): the on-screen direction of a
 * galaxy's north or of a comet's antisolar tail.
 */
export function screenAngle(v: ReadonlyVec3, right: ReadonlyVec3, up: ReadonlyVec3): number {
  return Math.atan2(dot3(v, up), dot3(v, right));
}

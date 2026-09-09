// Deep-sky object appearance rules (SKY-3, brief l.211, plan D101): the magnitude and angular
// size limits that follow the field of view, the symbol radius, the on-screen position angle of
// an elongated object and the packing of the per-object shader attributes. Pure, dependency-free,
// allocation-free. The DSO shaders mirror `dsoVisible`, `dsoPixelRadius` and the position-angle
// rule with the constants exported here, so the CPU twin (picking, the marker, the debug hook)
// and the GPU agree.

import { screenAngle } from './apparent';
import { DEG } from './frames';
import { zoomFraction } from './stars';
import type { ReadonlyVec3, Vec3 } from './typed';

/** Objects brighter than this are drawn at a 90 degree (or wider) field of view. */
export const DSO_WIDE_FIELD_MAG_LIMIT = 7;
/** ... rising on the same log scale as the stars to this at 1 degree and narrower. */
export const DSO_NARROW_FIELD_MAG_LIMIT = 14;
/** A manual `maglim` (SKY-1 override) shows deep-sky objects one magnitude fainter than stars. */
export const DSO_MANUAL_LIMIT_OFFSET = 1;
/** Objects whose major axis spans at least 1/300 of the vertical field are drawn whatever their magnitude. */
export const DSO_SIZE_LIMIT_FRACTION = 1 / 300;
/** Magnitude sentinel of an object without one: never passes the magnitude test. */
export const DSO_MAG_UNKNOWN = 99;
/** Smallest symbol radius so a faint galaxy still reads as a symbol (CSS pixels). */
export const DSO_MIN_RADIUS_PX = 4;
/** Stroke width of the symbols (CSS pixels). */
export const DSO_LINE_WIDTH_PX = 1.2;

/** The six symbol classes, in the order of the contract's `DsoEntry.type` enum (state/types.ts `DSO_TYPES`). */
export const DSO_SYMBOL_TYPES = [
  'galaxy',
  'open_cluster',
  'globular_cluster',
  'planetary_nebula',
  'nebula',
  'other',
] as const;

const ARCMIN_TO_RAD = DEG / 60;
/** Below this squared length the tangent toward the pole is undefined (the object sits at a pole). */
const TANGENT_EPSILON = 1e-12;

/** `7 + 7 zoom(fov)`: 7 at 90 degrees and wider, 14 at 1 degree and narrower, logarithmic between. */
export function dsoMagnitudeLimitForFov(fovDeg: number): number {
  return (
    DSO_WIDE_FIELD_MAG_LIMIT +
    (DSO_NARROW_FIELD_MAG_LIMIT - DSO_WIDE_FIELD_MAG_LIMIT) * zoomFraction(fovDeg)
  );
}

/** The magnitude limit in force: the field-of-view rule, or the manual limit plus one. */
export function dsoMagnitudeLimit(fovDeg: number, manualMagLimit: number | null): number {
  return manualMagLimit === null
    ? dsoMagnitudeLimitForFov(fovDeg)
    : manualMagLimit + DSO_MANUAL_LIMIT_OFFSET;
}

/** Major-axis threshold in arcminutes: 12' at a 60 degree field, 0.2' at 1 degree. */
export function dsoSizeLimitArcmin(fovDeg: number): number {
  return fovDeg * 60 * DSO_SIZE_LIMIT_FRACTION;
}

/**
 * Drawn when bright enough OR large enough (SKY-3 "magnitude or angular size"). Unknown values
 * travel as `DSO_MAG_UNKNOWN` and a zero major axis, which fail their own test.
 */
export function dsoVisible(
  mag: number,
  majorArcmin: number,
  magLimit: number,
  sizeLimitArcmin: number,
): boolean {
  return mag <= magLimit || majorArcmin >= sizeLimitArcmin;
}

/**
 * Symbol radius in pixels: the true angular semi-axis on screen (exact at the centre, like the
 * bodies) or `minPx`, whichever is larger.
 */
export function dsoPixelRadius(
  majorSemiAxisRad: number,
  fovRad: number,
  heightPx: number,
  minPx: number,
): number {
  return Math.max(minPx, (Math.tan(majorSemiAxisRad) / Math.tan(fovRad / 2)) * heightPx * 0.5);
}

/**
 * Unit tangent toward the ICRF north pole at direction `d`, `normalize(Z - (Z . d) d)`, into
 * `out`; `false` (and `out` untouched) at the poles, where north is undefined.
 */
export function northTangent(out: Vec3, d: ReadonlyVec3): boolean {
  const k = d[2];
  const x = -k * d[0];
  const y = -k * d[1];
  const z = 1 - k * d[2];
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

/**
 * On-screen angle of an object's major axis, radians counter-clockwise from screen right: the
 * screen angle of its north tangent (rotated into ENU) plus the position angle. A position angle
 * is measured from north through east, and east lies to the LEFT of north when the sky is seen
 * from inside the sphere, so north-through-east is counter-clockwise on screen as well.
 */
export function screenPositionAngle(
  northEnu: ReadonlyVec3,
  right: ReadonlyVec3,
  up: ReadonlyVec3,
  paRad: number,
): number {
  return screenAngle(northEnu, right, up) + paRad;
}

/** Symbol class 0..5 of a contract `type`; an unknown string draws the `other` diamond. */
export function symbolIdOf(type: string): number {
  switch (type) {
    case 'galaxy':
      return 0;
    case 'open_cluster':
      return 1;
    case 'globular_cluster':
      return 2;
    case 'planetary_nebula':
      return 3;
    case 'nebula':
      return 4;
    default:
      return 5;
  }
}

/**
 * The `dsoShape` attribute of one object at `out[offset .. offset + 3]`: (magnitude or 99, major
 * semi-axis in radians or 0, minor/major ratio or 1, position angle in radians or 0), from the
 * optional contract fields (`null` and `undefined` both mean unknown).
 */
export function writeDsoShape(
  out: Float32Array,
  offset: number,
  mag: number | null | undefined,
  majorArcmin: number | null | undefined,
  minorArcmin: number | null | undefined,
  paDeg: number | null | undefined,
): void {
  const major = majorArcmin ?? 0;
  out[offset] = mag ?? DSO_MAG_UNKNOWN;
  out[offset + 1] = (major / 2) * ARCMIN_TO_RAD;
  out[offset + 2] =
    minorArcmin === null || minorArcmin === undefined || major <= 0 ? 1 : minorArcmin / major;
  out[offset + 3] = (paDeg ?? 0) * DEG;
}

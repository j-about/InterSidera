// Reference frames of the client (plan D72, ADR-0009). Pure, dependency-free.
//
// Horizon frame: local ENU, components ordered [East, North, Up], azimuth measured from north
// through east (brief l.56). Babylon.js is left-handed and Y-up; the mapping ENU -> Babylon
// (East -> +X, Up -> +Y, North -> +Z, brief l.59) exists ONLY in this module: every sky mesh keeps
// its geometry in ENU and carries `enuToBabylonMatrix()` as its frozen world matrix, so no shader
// and no other module ever swaps axes. Unit tests assert az=0 -> +Z, az=90 -> +X, alt=90 -> +Y.
//
// Roll (plan D119, amending D72 "the camera never rolls" to "only in AR"): the camera functions
// take a trailing `rollDeg = 0`, the rotation of the camera about its view axis, right-handed in
// ENU, positive when the screen top leans to the user's right (`up = up0 cos r + right0 sin r`,
// `right = right0 cos r - up0 sin r`); with roll +90 looking north the screen top points east and
// the zenith side of the field lands on the LEFT edge. Babylon's `TargetCamera` takes it as
// `rotation.z = -roll`: P is a reflection (determinant -1), so a right-handed rotation about the
// forward axis in ENU is a left-handed one in Babylon's frame. Verified on the `NullEngine`
// against these formulas (4e-8 in Float32). The camera rolls only in AR (`ar.roll`, 0 elsewhere).

import { rotate } from './quaternion';
import type { ReadonlyQuat, ReadonlyVec3, Vec3 } from './typed';

/** Radius of the celestial sphere in Babylon units (brief l.59). */
export const SKY_RADIUS = 1000;
export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

/** The camera pitch is kept away from the poles, where `LookAtLH` is degenerate (plan D72). */
export const MAX_CAMERA_ALT_DEG = 89.99;
export const MIN_FOV_DEG = 1;
export const MAX_FOV_DEG = 120;

/** Altitude and azimuth in degrees. */
export interface AltAz {
  alt: number;
  az: number;
}

/** ENU unit vector `[E, N, U]` of a direction given in degrees. */
export function altAzToEnu(out: Vec3, altDeg: number, azDeg: number): Vec3 {
  const alt = altDeg * DEG;
  const az = azDeg * DEG;
  const c = Math.cos(alt);
  out[0] = c * Math.sin(az);
  out[1] = c * Math.cos(az);
  out[2] = Math.sin(alt);
  return out;
}

/** Altitude in degrees of an ENU vector (`asin(U / |v|)`), clamped against rounding. */
export function altitudeDeg(e: number, n: number, u: number): number {
  const len = Math.hypot(e, n, u);
  if (!(len > 0)) {
    return 0;
  }
  return Math.asin(Math.max(-1, Math.min(1, u / len))) * RAD;
}

/** Azimuth in degrees of an ENU vector, from north through east, in `[0, 360)`. */
export function azimuthDeg(e: number, n: number): number {
  return wrapAzimuthDeg(Math.atan2(e, n) * RAD);
}

/** Altitude and azimuth of an ENU vector, written into `out`. */
export function enuToAltAz(out: AltAz, e: number, n: number, u: number): AltAz {
  out.alt = altitudeDeg(e, n, u);
  out.az = azimuthDeg(e, n);
  return out;
}

/** Wrap an azimuth into `[0, 360)` (`360` becomes `0`, never `-0`). */
export function wrapAzimuthDeg(azDeg: number): number {
  const wrapped = azDeg - 360 * Math.floor(azDeg / 360);
  return wrapped >= 360 || wrapped <= 0 ? 0 : wrapped;
}

/**
 * Wrap a signed angle into `[-180, 180)` (`180` becomes `-180`, never `-0`): the AR-3 calibration
 * offset and the XR yaw correction (plan D120, D130). Built on `wrapAzimuthDeg`, whose guards
 * already absorb the rounding at the seam (`180 - 180` is `+0`).
 */
export function wrapSignedDeg(deg: number): number {
  return wrapAzimuthDeg(deg + 180) - 180;
}

/** Clamp an altitude to the range the camera can look at (plan D72). */
export function clampCameraAltDeg(altDeg: number): number {
  return Math.max(-MAX_CAMERA_ALT_DEG, Math.min(MAX_CAMERA_ALT_DEG, altDeg));
}

/** Clamp a vertical field of view to `[1, 120]` degrees (VIEW-1). */
export function clampFovDeg(fovDeg: number): number {
  return Math.max(MIN_FOV_DEG, Math.min(MAX_FOV_DEG, fovDeg));
}

/**
 * The ENU -> Babylon axis permutation P as a 16-element array in Babylon's `Matrix` layout
 * (`m[12..14]` would hold a translation; Babylon applies matrices to row vectors, so
 * `x' = sum_i v_i m[4 i + j]`). P maps (E, N, U) to (E, U, N): `x' = E`, `y' = U`, `z' = N`.
 * Its determinant is -1: it is a reflection, which is why it cannot be folded into the horizon
 * quaternion and is applied as the world matrix of every sky mesh instead (ADR-0009). P is
 * symmetric, so the row/column question does not arise.
 */
export function enuToBabylonMatrix(): Float32Array {
  const m = new Float32Array(16);
  m[0] = 1; // x' <- E
  m[6] = 1; // z' <- N
  m[9] = 1; // y' <- U
  m[15] = 1;
  return m;
}

/** ENU vector -> Babylon coordinates `[x, y, z] = [E, U, N]` (the same mapping as the matrix). */
export function enuToBabylon(out: Vec3, e: number, n: number, u: number): Vec3 {
  out[0] = e;
  out[1] = u;
  out[2] = n;
  return out;
}

/** Babylon coordinates -> ENU `[E, N, U]`. */
export function babylonToEnu(out: Vec3, x: number, y: number, z: number): Vec3 {
  out[0] = x;
  out[1] = z;
  out[2] = y;
  return out;
}

/**
 * Euler rotation `[x, y, z]` in radians for a Babylon `TargetCamera` at the origin looking toward
 * (`azDeg`, `altDeg`): yaw about +Y equals the azimuth (az=0 looks +Z = north, az=90 looks +X =
 * east) and a positive pitch looks down, so `x = -alt`; `z = -roll` (module header). Verified
 * against Babylon 9.25's `RotationYawPitchRoll` (plan D72, D119). `0 - ...` keeps `z` at `+0`
 * for a zero roll.
 */
export function cameraRotationFor(out: Vec3, azDeg: number, altDeg: number, rollDeg = 0): Vec3 {
  out[0] = -clampCameraAltDeg(altDeg) * DEG;
  out[1] = wrapAzimuthDeg(azDeg) * DEG;
  out[2] = 0 - rollDeg * DEG;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Equatorial coordinates and the J2000 ecliptic (plan D72, Q29).

/**
 * Mean obliquity of the ecliptic at J2000.0 (IAU 2006, 84381.406"): a constant of the J2000
 * frame definition, not a computed position, so drawing the J2000 ecliptic from it stays within
 * brief l.41. The ecliptic of date would need a backend rotation (maintainer question 17).
 */
export const ECLIPTIC_OBLIQUITY_J2000_ARCSEC = 84381.406;

/**
 * The J2000 ecliptic north pole in ICRF: RA 270 deg, Dec 90 - epsilon, i.e. `+Z` rotated about
 * the equinox axis `+X` by `+epsilon` toward `-Y`: `(0, -sin eps, cos eps)`.
 */
export function eclipticPoleIcrf(out: Vec3): Vec3 {
  const eps = (ECLIPTIC_OBLIQUITY_J2000_ARCSEC / 3600) * DEG;
  out[0] = 0;
  out[1] = -Math.sin(eps);
  out[2] = Math.cos(eps);
  return out;
}

/** Right ascension and declination in degrees. */
export interface RaDec {
  ra: number;
  dec: number;
}

/** Unit vector of equatorial coordinates (ICRF or of date, whichever frame `ra`/`dec` refer to). */
export function dirFromRaDec(out: Vec3, raDeg: number, decDeg: number): Vec3 {
  const ra = raDeg * DEG;
  const dec = decDeg * DEG;
  const c = Math.cos(dec);
  out[0] = c * Math.cos(ra);
  out[1] = c * Math.sin(ra);
  out[2] = Math.sin(dec);
  return out;
}

/** Right ascension in `[0, 360)` and declination of a vector, written into and returning `out`. */
export function raDecFromDir(out: RaDec, v: ReadonlyVec3): RaDec {
  out.ra = wrapAzimuthDeg(Math.atan2(v[1], v[0]) * RAD);
  out.dec = altitudeDeg(v[0], v[1], v[2]);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Pinhole projection (plan D72, D85): the pure twin of Babylon's `Vector3.Project` for a
// `TargetCamera` at the origin with `FOVMODE_VERTICAL_FIXED`. Camera axes in ENU: forward = the
// view direction `altAzToEnu(viewAlt, viewAz)`, right = the horizontal unit vector 90 degrees
// clockwise from the view azimuth `(cos az, -sin az, 0)` (east when looking north), up = right x
// forward, both then rolled about forward (module header). In Babylon's left-handed frame these
// are +Z, +X and +Y for the identity camera, which is exactly `enuToBabylon`. NDC:
// `x = x_cam / (z_cam tan(fov / 2) aspect)`,
// `y = y_cam / (z_cam tan(fov / 2))`, `aspect = width / height`; screen x grows to the right,
// screen y downward: `px = (x + 1) / 2 * width`, `py = (1 - y) / 2 * height`.

/** A point in CSS pixels, origin top-left. */
export interface ScreenPoint {
  x: number;
  y: number;
}

const camForward: Vec3 = [0, 0, 0];
const camRight: Vec3 = [0, 0, 0];
const camUp: Vec3 = [0, 0, 0];
const camTarget: Vec3 = [0, 0, 0];

/**
 * The camera axes in ENU for a view (az, alt) in degrees, into `outForward`, `outRight` and
 * `outUp`: forward is the view direction, right the horizontal unit vector 90 degrees clockwise
 * from the view azimuth, up their cross product, then right and up rolled about forward by
 * `rollDeg` (0 outside AR; header). Shared by the projections below, the billboard bases of the
 * body and DSO layers and the background shader (plan D104), so there is exactly one camera basis
 * in the client.
 */
export function cameraBasis(
  outForward: Vec3,
  outRight: Vec3,
  outUp: Vec3,
  viewAz: number,
  viewAlt: number,
  rollDeg = 0,
): void {
  altAzToEnu(outForward, viewAlt, viewAz);
  const az = viewAz * DEG;
  const r0x = Math.cos(az);
  const r0y = -Math.sin(az);
  // up0 = right0 x forward (right0 has no vertical component)
  const u0x = r0y * outForward[2];
  const u0y = -r0x * outForward[2];
  const u0z = r0x * outForward[1] - r0y * outForward[0];
  // Roll: right = right0 cos r - up0 sin r, up = up0 cos r + right0 sin r.
  const r = rollDeg * DEG;
  const c = Math.cos(r);
  const s = Math.sin(r);
  outRight[0] = r0x * c - u0x * s;
  outRight[1] = r0y * c - u0y * s;
  outRight[2] = 0 - u0z * s;
  outUp[0] = u0x * c + r0x * s;
  outUp[1] = u0y * c + r0y * s;
  outUp[2] = u0z * c;
}

/**
 * The camera axes in ENU of a Babylon camera whose world rotation is the quaternion `q` (the XR
 * rig camera, plan D130): `q` rotates Babylon's +Z (forward), +X (right) and +Y (up), and each
 * result is relabelled through `babylonToEnu`. For the quaternion of `cameraRotationFor(az, alt,
 * roll)` (Babylon's `RotationYawPitchRoll` = Hamilton `qy(yaw) qx(pitch) qz(roll)`) it returns
 * exactly `cameraBasis(az, alt, roll)`, which the unit tests pin. Allocation-free.
 */
export function basisFromBabylonQuaternion(
  outForward: Vec3,
  outRight: Vec3,
  outUp: Vec3,
  q: ReadonlyQuat,
): void {
  rotate(outForward, q, BABYLON_FORWARD);
  babylonToEnu(outForward, outForward[0], outForward[1], outForward[2]);
  rotate(outRight, q, BABYLON_RIGHT);
  babylonToEnu(outRight, outRight[0], outRight[1], outRight[2]);
  rotate(outUp, q, BABYLON_UP);
  babylonToEnu(outUp, outUp[0], outUp[1], outUp[2]);
}

const BABYLON_FORWARD: ReadonlyVec3 = [0, 0, 1];
const BABYLON_RIGHT: ReadonlyVec3 = [1, 0, 0];
const BABYLON_UP: ReadonlyVec3 = [0, 1, 0];

/**
 * The azimuth change in degrees a horizontal drag of `dxPx` CSS pixels means under a vertical
 * field `fovDeg` on a canvas `heightPx` tall: `-dx fov / height` (dragging right turns the view
 * left, as the camera controller does), the rule the AR-3 calibration drag shares (plan D120).
 * A non-positive or unknown height gives 0.
 */
export function dragDeltaDeg(dxPx: number, fovDeg: number, heightPx: number): number {
  return heightPx > 0 ? 0 - (dxPx * fovDeg) / heightPx : 0;
}

/** The sky direction under the screen point (`px`, `py`) for the given view. */
export function screenToDirection(
  out: AltAz,
  px: number,
  py: number,
  width: number,
  height: number,
  fovDeg: number,
  viewAz: number,
  viewAlt: number,
  rollDeg = 0,
): AltAz {
  cameraBasis(camForward, camRight, camUp, viewAz, viewAlt, rollDeg);
  const t = Math.tan((fovDeg / 2) * DEG);
  const xNdc = (2 * px) / width - 1;
  const yNdc = 1 - (2 * py) / height;
  const sx = xNdc * t * (width / height);
  const sy = yNdc * t;
  camTarget[0] = camForward[0] + sx * camRight[0] + sy * camUp[0];
  camTarget[1] = camForward[1] + sx * camRight[1] + sy * camUp[1];
  camTarget[2] = camForward[2] + sx * camRight[2] + sy * camUp[2];
  return enuToAltAz(out, camTarget[0], camTarget[1], camTarget[2]);
}

/**
 * Screen position of a sky direction for the given view; `false` (and `out` untouched) when the
 * direction is behind the camera. Points in front but outside the viewport are still projected.
 */
export function directionToScreen(
  out: ScreenPoint,
  altDeg: number,
  azDeg: number,
  width: number,
  height: number,
  fovDeg: number,
  viewAz: number,
  viewAlt: number,
  rollDeg = 0,
): boolean {
  cameraBasis(camForward, camRight, camUp, viewAz, viewAlt, rollDeg);
  altAzToEnu(camTarget, altDeg, azDeg);
  const zCam =
    camTarget[0] * camForward[0] + camTarget[1] * camForward[1] + camTarget[2] * camForward[2];
  if (zCam <= 0) {
    return false;
  }
  const xCam = camTarget[0] * camRight[0] + camTarget[1] * camRight[1] + camTarget[2] * camRight[2];
  const yCam = camTarget[0] * camUp[0] + camTarget[1] * camUp[1] + camTarget[2] * camUp[2];
  const t = Math.tan((fovDeg / 2) * DEG);
  const xNdc = xCam / (zCam * t * (width / height));
  const yNdc = yCam / (zCam * t);
  out.x = ((xNdc + 1) / 2) * width;
  out.y = ((1 - yNdc) / 2) * height;
  return true;
}

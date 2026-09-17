// Device orientation -> camera pose (AR-2, brief l.546; plan D117, D118, D130). Pure,
// dependency-free, allocation-free: every kernel writes into `out` and the per-frame functions
// reuse module-level scratch vectors, as `frames.ts` does.
//
// Frames and conventions:
// - Device frame (W3C Device Orientation and Motion, "deviceorientation"): `x` to the right of
//   the screen, `y` toward the top, `z` out of the screen toward the user, fixed to the device in
//   its natural (portrait) orientation; a screen rotation does not move it. The rear camera looks
//   along device `-z` (brief l.547) and the top of the rendered page is device `+y` before the
//   screen fold.
// - Earth frame: the spec's `[X East, Y North, Z Up]`, which is exactly the ENU tuple of
//   `frames.ts`; azimuth from north through east.
// - Angles: `alpha` about `z` in [0, 360), `beta` about `x'` in [-180, 180), `gamma` about `y''`
//   in [-90, 90), intrinsic Z-X'-Y''. The spec matrix `R = Rz(alpha) Rx(beta) Ry(gamma)`
//   (Appendix A `getRotationMatrix`) equals the Hamilton product `qz(alpha) qx(beta) qy(gamma)` of
//   `quaternion.ts` (`[x, y, z, w]`, `v' = q v q^-1`; verified to 1e-15 in the research probes).
// - `screen.orientation.angle` is counter-clockwise from the natural orientation (Screen
//   Orientation API): the page frame is the device frame turned back by it, `q_page = q_device
//   qz(-angle)`, so the page top `(0, 1, 0)` and the camera axis `(0, 0, -1)` read in the page frame
//   land where the browser shows them.
// - View: `alt = asin(f_U)`, `az = atan2(f_E, f_N)` in [0, 360) for the camera axis `f`;
//   `roll = atan2(u . right0, u . up0)` in (-180, 180] with the no-roll basis of
//   `frames.ts::cameraBasis` (`right0 = (cos az, -sin az, 0)`, `up0 = right0 x f`): right-handed
//   about the view axis in ENU, positive when the screen top leans to the user's right (with roll
//   +90 looking north the screen top points east). Gimbal band `|alt| >= MAX_CAMERA_ALT_DEG`
//   (the camera clamp of `frames.ts`): `roll = 0` and `az` is the azimuth of the screen top at
//   the nadir (the spec's own "compass heading" example: flat, top west, alpha 90 -> 270) or that
//   azimuth plus 180 at the zenith, both continuous with the neighbouring poses.
// - Compass (iOS): `webkitCompassHeading` is the magnetic heading of a device axis (the top
//   `COMPASS_AXIS_TOP` per CoreLocation's default, `COMPASS_AXIS_BACK` if the device run shows
//   the rear axis when upright, plan R74); the relative pose is corrected by a rotation about Up
//   that brings that axis to the reported heading. `qRel` is the DEVICE quaternion, before the
//   screen fold: the axis is a device axis, so `pageQuaternion` comes after the correction (with
//   a non-zero screen angle the other order is wrong). Both platforms report MAGNETIC north
//   (B-74).
// - XR (plan D130): `applyYaw` composes a yaw about Babylon's world vertical (ENU Up through
//   `frames.ts::enuToBabylon`; azimuth in Babylon's frame, `RotationYawPitchRoll` = Hamilton
//   `qy qx qz`) in front of the rig quaternion, `viewFromAxes` turns the rig's ENU basis
//   (`frames.ts::basisFromBabylonQuaternion`) into the same `(az, alt, roll)` rule as the
//   sensors, and `fovAspectFromProjection` reads the vertical field and the aspect of a
//   column-major projection matrix (`m[5] = 1 / tan(fov / 2)`, `m[0] = m[5] / aspect`).

import type { CompassLevel, HeadingSource } from '../../state/types';
import { MAX_CAMERA_ALT_DEG, DEG, RAD, azimuthDeg, enuToBabylon, wrapAzimuthDeg } from './frames';
import { copyQ, fromAxisAngle, multiplyQ, rotate, slerp } from './quaternion';
import type { Quat, ReadonlyQuat, ReadonlyVec3, Vec3 } from './typed';
import { at } from './typed';

/** Time constant of the pose smoothing, seconds (five frames at 60 Hz; plan D116, R77). */
export const SMOOTHING_TAU_S = 0.08;
/** A sample older than this is stale: `failAr('orientationUnavailable')` (plan D116, R76). */
export const STALE_SAMPLE_MS = 3000;
/** A compass accuracy up to this is `good`, up to `COMPASS_FAIR_MAX_DEG` `fair`, beyond `poor` (Q53). */
export const COMPASS_GOOD_MAX_DEG = 15;
export const COMPASS_FAIR_MAX_DEG = 35;
/** The device axis CoreLocation's heading refers to by default: the top of the device. */
export const COMPASS_AXIS_TOP: ReadonlyVec3 = [0, 1, 0];
/** The rear camera axis, the alternative reference for an upright phone (plan R74). */
export const COMPASS_AXIS_BACK: ReadonlyVec3 = [0, 0, -1];

// The coordinate axes of the W3C frames: device `x`, `y`, `z` and Earth `E`, `N`, `U` alike.
const X_AXIS: ReadonlyVec3 = [1, 0, 0];
const Y_AXIS: ReadonlyVec3 = [0, 1, 0];
const Z_AXIS: ReadonlyVec3 = [0, 0, 1];
/**
 * Babylon's world vertical, the axis of the XR yaw: ENU Up sent through the one ENU -> Babylon
 * mapping of `frames.ts` (`enuToBabylon`), so the relabelling is never restated here.
 */
const BABYLON_UP_AXIS: ReadonlyVec3 = enuToBabylon([0, 0, 0], 0, 0, 1);
/** The rear camera looks along device `-z`. */
const DEVICE_FORWARD: ReadonlyVec3 = [0, 0, -1];
/** The top of the rendered page is device `+y` once the screen angle is folded in. */
const DEVICE_UP: ReadonlyVec3 = [0, 1, 0];

// Scratch (never returned, never aliased with a caller's `out`).
const qTmpA: Quat = [0, 0, 0, 1];
const qTmpB: Quat = [0, 0, 0, 1];
const fwdTmp: Vec3 = [0, 0, 0];
const upTmp: Vec3 = [0, 0, 0];
const axisTmp: Vec3 = [0, 0, 0];

/** Azimuth, altitude and roll of the camera in degrees (`az` in [0, 360), `roll` in (-180, 180]). */
export interface ViewPose {
  az: number;
  alt: number;
  roll: number;
}

/** Vertical field of view in radians and the width / height aspect of a projection. */
export interface FovAspect {
  fovRad: number;
  aspect: number;
}

/**
 * Wrap a signed angle into `(-180, 180]` (`-180` becomes `180`): the roll and the XR yaw
 * correction. The twin of `frames.ts::wrapSignedDeg`, which closes the other end; both rest on
 * `wrapAzimuthDeg`, whose guards absorb the rounding at the seam.
 */
export function wrapSigned180Deg(deg: number): number {
  return 180 - wrapAzimuthDeg(180 - deg);
}

/**
 * The device -> Earth (ENU) rotation of a `deviceorientation` triple in degrees:
 * `qz(alpha) qx(beta) qy(gamma)`, the spec matrix `Rz(alpha) Rx(beta) Ry(gamma)` as a quaternion.
 */
export function deviceQuaternion(
  out: Quat,
  alphaDeg: number,
  betaDeg: number,
  gammaDeg: number,
): Quat {
  fromAxisAngle(qTmpA, Z_AXIS, alphaDeg * DEG);
  fromAxisAngle(qTmpB, X_AXIS, betaDeg * DEG);
  multiplyQ(qTmpA, qTmpA, qTmpB);
  fromAxisAngle(qTmpB, Y_AXIS, gammaDeg * DEG);
  return multiplyQ(out, qTmpA, qTmpB);
}

/**
 * Fold the screen rotation into the device rotation: `q_page = q_device qz(-angle)` with
 * `screen.orientation.angle` in degrees counter-clockwise from the natural orientation, so the
 * page frame's `+y` is the top of what the browser shows.
 */
export function pageQuaternion(out: Quat, qDevice: ReadonlyQuat, screenAngleDeg: number): Quat {
  fromAxisAngle(qTmpA, Z_AXIS, (0 - screenAngleDeg) * DEG);
  return multiplyQ(out, qDevice, qTmpA);
}

/**
 * The camera pose of a page-frame rotation: forward `= rotate(q, (0, 0, -1))`, up
 * `= rotate(q, (0, 1, 0))`, then the header's `az`, `alt`, `roll` rule with the gimbal band at
 * `|alt| >= MAX_CAMERA_ALT_DEG` (roll 0, azimuth from the screen top; +180 at the zenith).
 */
export function viewFromPose(out: ViewPose, qPage: ReadonlyQuat): ViewPose {
  rotate(fwdTmp, qPage, DEVICE_FORWARD);
  rotate(upTmp, qPage, DEVICE_UP);
  return viewFromAxes(out, fwdTmp, upTmp);
}

/**
 * The camera pose of an ENU camera basis given by its unit `forward` and `up` axes (the XR rig
 * through `frames.ts::basisFromBabylonQuaternion`, plan D130; `viewFromPose` for the sensors):
 * the header's `az`, `alt`, `roll` rule with the gimbal band at `|alt| >= MAX_CAMERA_ALT_DEG`
 * (roll 0, azimuth from the screen top; +180 at the zenith). `roll` is the angle of `up` from the
 * no-roll basis of `frames.ts::cameraBasis`, so `cameraBasis(az, alt, roll)` rebuilds the input.
 */
export function viewFromAxes(out: ViewPose, forward: ReadonlyVec3, up: ReadonlyVec3): ViewPose {
  const alt = Math.asin(Math.max(-1, Math.min(1, forward[2]))) * RAD;
  out.alt = alt;
  if (Math.abs(alt) >= MAX_CAMERA_ALT_DEG) {
    const topAz = azimuthDeg(up[0], up[1]);
    out.az = alt > 0 ? wrapAzimuthDeg(topAz + 180) : topAz;
    out.roll = 0;
    return out;
  }
  const az = azimuthDeg(forward[0], forward[1]);
  out.az = az;
  const a = az * DEG;
  // The no-roll basis of frames.ts::cameraBasis: right0 horizontal, up0 = right0 x forward.
  const r0x = Math.cos(a);
  const r0y = -Math.sin(a);
  const u0x = r0y * forward[2];
  const u0y = -r0x * forward[2];
  const u0z = r0x * forward[1] - r0y * forward[0];
  const uRight = up[0] * r0x + up[1] * r0y;
  const uUp = up[0] * u0x + up[1] * u0y + up[2] * u0z;
  out.roll = wrapSigned180Deg(Math.atan2(uRight, uUp) * RAD);
  return out;
}

/** Azimuth in degrees ([0, 360)) of a device `axis` rotated by `q` (0 when it points vertically). */
export function axisHeadingDeg(q: ReadonlyQuat, axis: ReadonlyVec3): number {
  rotate(axisTmp, q, axis);
  return azimuthDeg(axisTmp[0], axisTmp[1]);
}

/**
 * Correct a relative pose with a compass reading (iOS, plan D118): rotate `qRel` about Up so that
 * `axis` (the device axis CoreLocation measures) points to `compassHeadingDeg`:
 * `qz(heading(axis) - compass) qRel`. `qRel` is the device quaternion (`deviceQuaternion`), not
 * the page one: fold the screen angle afterwards. Flat, this is the spec's `alpha = 360 -
 * heading`; in general it recovers an arbitrary yaw offset exactly.
 */
export function compassCorrectedQuaternion(
  out: Quat,
  qRel: ReadonlyQuat,
  compassHeadingDeg: number,
  axis: ReadonlyVec3,
): Quat {
  const yawDeg = axisHeadingDeg(qRel, axis) - compassHeadingDeg;
  fromAxisAngle(qTmpA, Z_AXIS, yawDeg * DEG);
  return multiplyQ(out, qTmpA, qRel);
}

/**
 * One first-order smoothing step on the quaternion (frame-rate independent): `out = slerp(prev,
 * target, 1 - exp(-dt / tau))`; `dt <= 0` copies `prev`. Smoothing the rotation rather than the
 * angles avoids the azimuth wrap and the pole; `slerp` takes the short arc.
 */
export function smoothPose(
  out: Quat,
  prev: ReadonlyQuat,
  target: ReadonlyQuat,
  dtS: number,
  tauS: number,
): Quat {
  if (dtS <= 0) {
    return copyQ(out, prev);
  }
  return slerp(out, prev, target, 1 - Math.exp(-dtS / tauS));
}

/**
 * The compass-accuracy indicator (AR-2, plan D118): an absolute source is `good`; a compass is
 * `invalid` without a figure or with a negative one (uncalibrated, CoreLocation's convention),
 * `good` up to 15 degrees, `fair` up to 35, `poor` beyond; the relative source is `manual`
 * (the user aligns north by dragging, AR-3); no source is `none`.
 */
export function compassLevel(source: HeadingSource, accuracyDeg: number | null): CompassLevel {
  switch (source) {
    case 'absolute':
      return 'good';
    case 'compass':
      if (accuracyDeg === null || accuracyDeg < 0) {
        return 'invalid';
      }
      if (accuracyDeg <= COMPASS_GOOD_MAX_DEG) {
        return 'good';
      }
      return accuracyDeg <= COMPASS_FAIR_MAX_DEG ? 'fair' : 'poor';
    case 'relative':
      return 'manual';
    case 'none':
      return 'none';
  }
}

/** A yaw of `yawDeg` about Babylon's world vertical (azimuth in the Babylon frame, plan D130). */
export function yawQuaternion(out: Quat, yawDeg: number): Quat {
  return fromAxisAngle(out, BABYLON_UP_AXIS, yawDeg * DEG);
}

/**
 * Turn a Babylon-frame rotation `q` (the XR rig camera) by `yawDeg` about the world vertical:
 * `out = yaw(yawDeg) q`, the `q_total = yaw(delta) (x) q_rig` of plan D130; `out` may alias `q`.
 */
export function applyYaw(out: Quat, yawDeg: number, q: ReadonlyQuat): Quat {
  yawQuaternion(qTmpA, yawDeg);
  return multiplyQ(out, qTmpA, q);
}

/**
 * The yaw that turns a camera looking at `forwardAzDeg` toward `headingDeg`, wrapped to
 * `(-180, 180]` (plan D130: `delta0 = view.az - az_xr` at the first tracked XR frame).
 */
export function yawCorrectionDeg(headingDeg: number, forwardAzDeg: number): number {
  return wrapSigned180Deg(headingDeg - forwardAzDeg);
}

/**
 * Vertical field of view and aspect of a symmetric perspective matrix in the column-major layout
 * WebXR and Babylon share: `m[5] = 1 / tan(fov / 2)` and `m[0] = m[5] / aspect`, so `fov = 2
 * atan2(1, m[5])` and `aspect = m[5] / m[0]`. Throws `RangeError` for fewer than six entries.
 */
export function fovAspectFromProjection(out: FovAspect, m: ArrayLike<number>): FovAspect {
  const m0 = at(m, 0);
  const m5 = at(m, 5);
  out.fovRad = 2 * Math.atan2(1, m5);
  out.aspect = m5 / m0;
  return out;
}

// @vitest-environment node
// Device orientation -> camera pose (plan D117, D118, D130, D133) against
// `device_orientation_cases.json` (an independent Python implementation of the W3C matrix, the
// screen fold and the view rule) plus the properties the fixture cannot state: basis invariants,
// the gimbal band, smoothing, the compass level, the XR yaw and projection helpers.

import { loadOrientationCases } from '../../test/fixtures';
import type { OrientationPoseFixture } from '../../test/fixtures';
import {
  DEG,
  MAX_CAMERA_ALT_DEG,
  RAD,
  cameraBasis,
  cameraRotationFor,
  basisFromBabylonQuaternion,
  wrapSignedDeg,
} from './frames';
import type { FovAspect, ViewPose } from './orientation';
import {
  COMPASS_AXIS_BACK,
  COMPASS_AXIS_TOP,
  COMPASS_FAIR_MAX_DEG,
  COMPASS_GOOD_MAX_DEG,
  SMOOTHING_TAU_S,
  STALE_SAMPLE_MS,
  applyYaw,
  axisHeadingDeg,
  compassCorrectedQuaternion,
  compassLevel,
  deviceQuaternion,
  fovAspectFromProjection,
  pageQuaternion,
  smoothPose,
  viewFromAxes,
  viewFromPose,
  wrapSigned180Deg,
  yawCorrectionDeg,
  yawQuaternion,
} from './orientation';
import { copyQ, fromAxisAngle, multiplyQ, rotate, rotationAngle } from './quaternion';
import type { Quat, ReadonlyVec3 } from './typed';
import { at, quat, vec3 } from './typed';
import { cross3, dot3, length3 } from './vec3';

const fixture = loadOrientationCases();

const DEVICE_RIGHT: ReadonlyVec3 = [1, 0, 0];
const DEVICE_UP: ReadonlyVec3 = [0, 1, 0];
const DEVICE_FORWARD: ReadonlyVec3 = [0, 0, -1];

/** Deterministic PRNG (mulberry32), as in frames.test.ts. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Distance between two angles in degrees, modulo 360. */
function angleDiff(a: number, b: number): number {
  return Math.abs(wrapSignedDeg(a - b));
}

/** The page quaternion of a W3C triple and a screen angle (a fresh quaternion). */
function pageOf(alpha: number, beta: number, gamma: number, screenAngle: number): Quat {
  const device = deviceQuaternion(quat(), alpha, beta, gamma);
  return pageQuaternion(quat(), device, screenAngle);
}

/**
 * The page quaternion of a camera pose, built independently of the module: yaw the flat phone so
 * its top points to `az`, raise it about the device x by `90 + alt` (the camera then looks at
 * `az` up by `alt`), roll about the device z by `-roll` (the view axis is `-z`).
 */
function quaternionOfView(az: number, alt: number, roll: number): Quat {
  const qz = fromAxisAngle(quat(), [0, 0, 1], -az * DEG);
  const qx = fromAxisAngle(quat(), [1, 0, 0], (90 + alt) * DEG);
  const qr = fromAxisAngle(quat(), [0, 0, 1], -roll * DEG);
  return multiplyQ(quat(), multiplyQ(quat(), qz, qx), qr);
}

/** The Babylon-frame quaternion of `cameraRotationFor` (`RotationYawPitchRoll` = `qy qx qz`). */
function babylonQuaternionOf(az: number, alt: number, roll: number): Quat {
  const rotation = cameraRotationFor(vec3(), az, alt, roll);
  const qy = fromAxisAngle(quat(), [0, 1, 0], rotation[1]);
  const qx = fromAxisAngle(quat(), [1, 0, 0], rotation[0]);
  const qz = fromAxisAngle(quat(), [0, 0, 1], rotation[2]);
  return multiplyQ(quat(), multiplyQ(quat(), qy, qx), qz);
}

function expectPose(
  pose: ViewPose,
  expected: Pick<OrientationPoseFixture, 'az' | 'alt' | 'roll' | 'tolerance_deg'>,
): void {
  expect(angleDiff(pose.az, expected.az)).toBeLessThanOrEqual(expected.tolerance_deg);
  expect(Math.abs(pose.alt - expected.alt)).toBeLessThanOrEqual(expected.tolerance_deg);
  expect(angleDiff(pose.roll, expected.roll)).toBeLessThanOrEqual(expected.tolerance_deg);
}

function expectVec(actual: ReadonlyVec3, expected: ReadonlyVec3, tolerance: number): void {
  for (let i = 0; i < 3; i += 1) {
    expect(Math.abs(at(actual, i) - at(expected, i))).toBeLessThanOrEqual(tolerance);
  }
}

/** The spec's Appendix A `getRotationMatrix` (row-major, `v_E = R v_D`), transcribed. */
function w3cMatrix(alpha: number, beta: number, gamma: number): number[] {
  const x = beta * DEG;
  const y = gamma * DEG;
  const z = alpha * DEG;
  const cX = Math.cos(x);
  const cY = Math.cos(y);
  const cZ = Math.cos(z);
  const sX = Math.sin(x);
  const sY = Math.sin(y);
  const sZ = Math.sin(z);
  return [
    cZ * cY - sZ * sX * sY,
    -cX * sZ,
    cY * sZ * sX + cZ * sY,
    cY * sZ + cZ * sX * sY,
    cZ * cX,
    sZ * sY - cZ * cY * sX,
    -cX * sY,
    sX,
    cX * cY,
  ];
}

describe('the fixture', () => {
  it('has the header and the four groups the generator writes', () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(20);
    expect(fixture.round_trips).toHaveLength(fixture.parameters.round_trips);
    expect(fixture.compass_cases).toHaveLength(fixture.parameters.compass_cases);
    expect(fixture.gimbal_rows.length).toBeGreaterThanOrEqual(8);
    expect(fixture.parameters.gimbal_alt_deg).toBe(MAX_CAMERA_ALT_DEG);
    expect(fixture.parameters.closed_form_tolerance_deg).toBeLessThanOrEqual(1e-9);
    expect(fixture.parameters.round_trip_tolerance_deg).toBeLessThanOrEqual(1e-7);
  });
});

describe('deviceQuaternion and pageQuaternion', () => {
  it('equals the spec matrix Rz(alpha) Rx(beta) Ry(gamma) on random triples', () => {
    const random = rng(117);
    const q = quat();
    const v = vec3();
    for (let i = 0; i < 300; i += 1) {
      const alpha = 360 * random();
      const beta = -180 + 360 * random();
      const gamma = -90 + 180 * random();
      deviceQuaternion(q, alpha, beta, gamma);
      const m = w3cMatrix(alpha, beta, gamma);
      const axes: ReadonlyVec3[] = [DEVICE_RIGHT, DEVICE_UP, [0, 0, 1]];
      axes.forEach((axis, column) => {
        rotate(v, q, axis);
        for (let row = 0; row < 3; row += 1) {
          expect(Math.abs(at(v, row) - at(m, 3 * row + column))).toBeLessThan(1e-14);
        }
      });
      expect(Math.abs(Math.hypot(q[0], q[1], q[2], q[3]) - 1)).toBeLessThan(1e-14);
    }
  });

  it('folds the screen angle as qz(-angle); 0 and 360 leave the device rotation', () => {
    const device = deviceQuaternion(quat(), 33, 70, -20);
    const same = pageQuaternion(quat(), device, 0);
    const turn = pageQuaternion(quat(), device, 360);
    expect(rotationAngle(same, device)).toBeLessThan(1e-15);
    expect(rotationAngle(turn, device)).toBeLessThan(1e-12);
    // Angle 90 (turned counter-clockwise): the page top is the device's right edge.
    const folded = pageQuaternion(quat(), device, 90);
    const pageTop = rotate(vec3(), folded, DEVICE_UP);
    const deviceRight = rotate(vec3(), device, DEVICE_RIGHT);
    expectVec(pageTop, deviceRight, 1e-15);
  });
});

describe('closed-form cases of the fixture', () => {
  it.each(fixture.cases)('$id', (c) => {
    const q = pageOf(c.alpha, c.beta, c.gamma, c.screen_angle);
    expectVec(rotate(vec3(), q, DEVICE_FORWARD), c.forward_enu, 1e-12);
    expectVec(rotate(vec3(), q, DEVICE_UP), c.up_enu, 1e-12);
    const pose = viewFromPose({ az: NaN, alt: NaN, roll: NaN }, q);
    expectPose(pose, c);
    expect(pose.az).toBeGreaterThanOrEqual(0);
    expect(pose.az).toBeLessThan(360);
    expect(pose.roll).toBeGreaterThan(-180);
    expect(pose.roll).toBeLessThanOrEqual(180);
  });

  it('reproduces the W3C worked example: flat, top west, alpha 90 -> heading 270', () => {
    const flat = fixture.cases.find((c) => c.id === 'spec-flat-top-west');
    if (flat === undefined) {
      throw new Error('spec-flat-top-west missing from the fixture');
    }
    const q = pageOf(flat.alpha, flat.beta, flat.gamma, flat.screen_angle);
    expect(axisHeadingDeg(q, COMPASS_AXIS_TOP)).toBeCloseTo(270, 9);
    expect(viewFromPose({ az: 0, alt: 0, roll: 0 }, q).alt).toBe(-90);
  });
});

describe('round trips and gimbal rows of the fixture', () => {
  it('returns the pose the triple was decomposed from (every screen angle)', () => {
    const out: ViewPose = { az: 0, alt: 0, roll: 0 };
    const angles = new Set<number>();
    for (const c of fixture.round_trips) {
      angles.add(c.screen_angle);
      expectPose(viewFromPose(out, pageOf(c.alpha, c.beta, c.gamma, c.screen_angle)), c);
    }
    expect([...angles].sort((a, b) => a - b)).toEqual([0, 90, 180, 270]);
  });

  it('applies the gimbal rule inside the band and stays continuous across it', () => {
    const out: ViewPose = { az: 0, alt: 0, roll: 0 };
    let previous: { key: string; az: number; roll: number } | null = null;
    for (const row of fixture.gimbal_rows) {
      viewFromPose(out, pageOf(row.alpha, row.beta, row.gamma, row.screen_angle));
      expectPose(out, row);
      expect(Math.abs(out.alt) >= MAX_CAMERA_ALT_DEG).toBe(row.in_band);
      if (row.in_band) {
        expect(out.roll).toBe(0);
      }
      const key = `${String(row.alpha)}:${row.region}`;
      if (previous !== null && previous.key === key) {
        expect(angleDiff(out.az, previous.az)).toBeLessThan(1e-6);
        expect(angleDiff(out.roll, previous.roll)).toBeLessThan(1e-6);
      }
      previous = { key, az: out.az, roll: out.roll };
    }
    expect(fixture.gimbal_rows.some((row) => row.region === 'nadir' && row.in_band)).toBe(true);
    expect(fixture.gimbal_rows.some((row) => row.region === 'zenith' && row.in_band)).toBe(true);
    expect(fixture.gimbal_rows.some((row) => !row.in_band)).toBe(true);
  });
});

describe('viewFromPose properties', () => {
  it('yields an orthonormal camera basis with r x u = -f on random poses', () => {
    const random = rng(2026);
    const f = vec3();
    const u = vec3();
    const r = vec3();
    const c = vec3();
    for (let i = 0; i < 500; i += 1) {
      const q = pageOf(360 * random(), -180 + 360 * random(), -90 + 180 * random(), 90 * i);
      rotate(f, q, DEVICE_FORWARD);
      rotate(u, q, DEVICE_UP);
      rotate(r, q, DEVICE_RIGHT);
      expect(Math.abs(length3(f) - 1)).toBeLessThan(1e-12);
      expect(Math.abs(length3(u) - 1)).toBeLessThan(1e-12);
      expect(Math.abs(length3(r) - 1)).toBeLessThan(1e-12);
      expect(Math.abs(dot3(f, u))).toBeLessThan(1e-12);
      expect(Math.abs(dot3(f, r))).toBeLessThan(1e-12);
      expect(Math.abs(dot3(r, u))).toBeLessThan(1e-12);
      cross3(c, r, u);
      expectVec(c, [-f[0], -f[1], -f[2]], 1e-12);
    }
  });

  it('inverts quaternionOfView and cameraBasis on random poses (roll in (-180, 180])', () => {
    const random = rng(7);
    const out: ViewPose = { az: 0, alt: 0, roll: 0 };
    const f = vec3();
    const r = vec3();
    const u = vec3();
    for (let i = 0; i < 500; i += 1) {
      const az = 360 * random();
      const alt = -89 + 178 * random();
      const roll = -179.9 + 359.8 * random();
      const q = quaternionOfView(az, alt, roll);
      viewFromPose(out, q);
      expect(angleDiff(out.az, az)).toBeLessThan(1e-9);
      expect(Math.abs(out.alt - alt)).toBeLessThan(1e-9);
      expect(angleDiff(out.roll, roll)).toBeLessThan(1e-9);
      // The basis frames.ts builds from the pose is the basis the phone has.
      cameraBasis(f, r, u, out.az, out.alt, out.roll);
      expectVec(f, rotate(vec3(), q, DEVICE_FORWARD), 1e-9);
      expectVec(r, rotate(vec3(), q, DEVICE_RIGHT), 1e-9);
      expectVec(u, rotate(vec3(), q, DEVICE_UP), 1e-9);
    }
  });

  it('has roll 0 for gamma 0 and no screen fold while beta is in (0, 180), 180 beyond', () => {
    const random = rng(99);
    const out: ViewPose = { az: 0, alt: 0, roll: 0 };
    for (let beta = 1; beta < 180; beta += 1) {
      viewFromPose(out, pageOf(360 * random(), beta, 0, 0));
      expect(Math.abs(out.roll)).toBeLessThan(1e-9);
      expect(Math.abs(out.alt - (beta - 90))).toBeLessThan(1e-9);
    }
    // The screen faces the sky and the camera looks backwards: upside down, roll 180 on the
    // `(-180, 180]` seam (never -180).
    for (let beta = -179; beta < 0; beta += 1) {
      viewFromPose(out, pageOf(360 * random(), beta, 0, 0));
      expect(angleDiff(out.roll, 180)).toBeLessThan(1e-9);
      expect(out.roll).toBeGreaterThan(-180);
      expect(out.roll).toBeLessThanOrEqual(180);
    }
  });

  it('is continuous across the 89.99 degree threshold: the basis of the pose survives', () => {
    const out: ViewPose = { az: 0, alt: 0, roll: 0 };
    const f = vec3();
    const r = vec3();
    const u = vec3();
    for (const sign of [1, -1]) {
      for (const alt of [89.98, 89.989, 89.99, 89.995, 89.999]) {
        const q = quaternionOfView(50, sign * alt, 40);
        viewFromPose(out, q);
        expect(Math.abs(out.alt - sign * alt)).toBeLessThan(1e-9);
        if (alt >= MAX_CAMERA_ALT_DEG) {
          // In the band the roll is folded into the azimuth: zenith az - roll, nadir az + roll.
          expect(out.roll).toBe(0);
          expect(angleDiff(out.az, sign > 0 ? 50 - 40 : 50 + 40)).toBeLessThan(0.02);
        } else {
          expect(angleDiff(out.az, 50)).toBeLessThan(1e-6);
          expect(angleDiff(out.roll, 40)).toBeLessThan(1e-6);
        }
        cameraBasis(f, r, u, out.az, out.alt, out.roll);
        expectVec(f, rotate(vec3(), q, DEVICE_FORWARD), 1e-3);
        expectVec(r, rotate(vec3(), q, DEVICE_RIGHT), 1e-3);
        expectVec(u, rotate(vec3(), q, DEVICE_UP), 1e-3);
      }
    }
  });

  it('clamps a rounded-off forward component before asin', () => {
    // A slightly non-unit quaternion pushes f_U past 1: still the zenith, never NaN.
    const q: Quat = [0, 0, 0, 1];
    fromAxisAngle(q, [1, 0, 0], Math.PI);
    q[0] *= 1 + 1e-9;
    const pose = viewFromPose({ az: 0, alt: 0, roll: 0 }, q);
    expect(pose.alt).toBe(90);
    expect(pose.roll).toBe(0);
  });
});

describe('compass correction (iOS)', () => {
  it('recovers the true pose from the relative triple with either reference axis', () => {
    // The compass axes are DEVICE axes: the correction applies to the device quaternion and the
    // screen fold comes after it (the controller's order). The fixture draws every screen angle,
    // so correcting the page quaternion instead would fail here whenever the angle is not 0.
    expect(fixture.compass_cases.some((c) => c.screen_angle !== 0)).toBe(true);
    const out: ViewPose = { az: 0, alt: 0, roll: 0 };
    const corrected = quat();
    const page = quat();
    for (const c of fixture.compass_cases) {
      const relative = deviceQuaternion(quat(), c.alpha_rel, c.beta, c.gamma);
      // Uncorrected, the yaw offset (counter-clockwise about Up) lowers the azimuth by itself.
      viewFromPose(out, pageQuaternion(page, relative, c.screen_angle));
      expect(angleDiff(out.az, c.az - c.yaw_offset_deg)).toBeLessThanOrEqual(c.tolerance_deg);
      compassCorrectedQuaternion(corrected, relative, c.compass_heading_top, COMPASS_AXIS_TOP);
      expectPose(viewFromPose(out, pageQuaternion(page, corrected, c.screen_angle)), c);
      expect(
        angleDiff(axisHeadingDeg(corrected, COMPASS_AXIS_TOP), c.compass_heading_top),
      ).toBeLessThan(1e-9);
      compassCorrectedQuaternion(corrected, relative, c.compass_heading_back, COMPASS_AXIS_BACK);
      expectPose(viewFromPose(out, pageQuaternion(page, corrected, c.screen_angle)), c);
      expect(
        angleDiff(axisHeadingDeg(corrected, COMPASS_AXIS_BACK), c.compass_heading_back),
      ).toBeLessThan(1e-9);
    }
  });

  it('reduces to the spec rule alpha = 360 - heading for a flat phone', () => {
    const relative = pageOf(123, 0, 0, 0);
    const corrected = compassCorrectedQuaternion(quat(), relative, 40, COMPASS_AXIS_TOP);
    const expected = pageOf(320, 0, 0, 0);
    expect(rotationAngle(corrected, expected)).toBeLessThan(1e-12);
  });

  it('axisHeadingDeg is 0 for a vertical axis and the camera azimuth for the rear axis', () => {
    const upright = pageOf(0, 90, 0, 0);
    expect(axisHeadingDeg(upright, COMPASS_AXIS_TOP)).toBe(0);
    const east = pageOf(270, 90, 0, 0);
    expect(axisHeadingDeg(east, COMPASS_AXIS_BACK)).toBeCloseTo(90, 9);
  });
});

describe('smoothPose', () => {
  it('takes the short way across north (359 -> 1) with k = 1 - exp(-dt / tau)', () => {
    const prev = quaternionOfView(359, 10, 5);
    const target = quaternionOfView(1, 10, 5);
    const out = smoothPose(quat(), prev, target, SMOOTHING_TAU_S, SMOOTHING_TAU_S);
    const pose = viewFromPose({ az: 0, alt: 0, roll: 0 }, out);
    const k = 1 - Math.exp(-1);
    expect(angleDiff(pose.az, 359 + 2 * k)).toBeLessThan(1e-9);
    expect(pose.alt).toBeCloseTo(10, 9);
    expect(pose.roll).toBeCloseTo(5, 9);
    expect(rotationAngle(prev, out) / rotationAngle(prev, target)).toBeCloseTo(k, 9);
  });

  it('converges monotonically and copies the previous pose for dt <= 0', () => {
    const prev = quaternionOfView(120, -20, 0);
    const target = quaternionOfView(150, 25, 30);
    const state = copyQ(quat(), prev);
    let remaining = rotationAngle(state, target);
    for (let i = 0; i < 60; i += 1) {
      smoothPose(state, state, target, 1 / 60, SMOOTHING_TAU_S);
      const next = rotationAngle(state, target);
      expect(next).toBeLessThan(remaining);
      remaining = next;
    }
    // One second at tau 80 ms: exp(-12.5) of the initial 55 degree arc.
    expect(remaining * RAD).toBeLessThan(1e-3);
    expect(smoothPose(quat(), prev, target, 0, SMOOTHING_TAU_S)).toEqual(prev);
    expect(smoothPose(quat(), prev, target, -0.016, SMOOTHING_TAU_S)).toEqual(prev);
  });

  it('exports the tuning constants of plan D116', () => {
    expect(SMOOTHING_TAU_S).toBe(0.08);
    expect(STALE_SAMPLE_MS).toBe(3000);
  });
});

describe('compassLevel', () => {
  it('covers every source and threshold', () => {
    expect(COMPASS_GOOD_MAX_DEG).toBe(15);
    expect(COMPASS_FAIR_MAX_DEG).toBe(35);
    expect(compassLevel('absolute', null)).toBe('good');
    expect(compassLevel('absolute', 80)).toBe('good');
    expect(compassLevel('compass', null)).toBe('invalid');
    expect(compassLevel('compass', -1)).toBe('invalid');
    expect(compassLevel('compass', 0)).toBe('good');
    expect(compassLevel('compass', 15)).toBe('good');
    expect(compassLevel('compass', 15.5)).toBe('fair');
    expect(compassLevel('compass', 35)).toBe('fair');
    expect(compassLevel('compass', 35.1)).toBe('poor');
    expect(compassLevel('relative', null)).toBe('manual');
    expect(compassLevel('relative', 10)).toBe('manual');
    expect(compassLevel('none', null)).toBe('none');
  });
});

describe('XR helpers (plan D130)', () => {
  it('applyYaw adds the yaw to the azimuth and leaves altitude and roll (aliasing allowed)', () => {
    const f = vec3();
    const r = vec3();
    const u = vec3();
    const fe = vec3();
    const re = vec3();
    const ue = vec3();
    const cases = [
      { az: 0, alt: 0, roll: 0, yaw: 90 },
      { az: 30, alt: 45, roll: -20, yaw: -75 },
      { az: 350, alt: -10, roll: 170, yaw: 33.3 },
    ];
    for (const { az, alt, roll, yaw } of cases) {
      const q = babylonQuaternionOf(az, alt, roll);
      const turned = applyYaw(quat(), yaw, q);
      basisFromBabylonQuaternion(f, r, u, turned);
      cameraBasis(fe, re, ue, az + yaw, alt, roll);
      expectVec(f, fe, 1e-12);
      expectVec(r, re, 1e-12);
      expectVec(u, ue, 1e-12);
      const aliased = copyQ(quat(), q);
      applyYaw(aliased, yaw, aliased);
      expect(rotationAngle(aliased, turned)).toBeLessThan(1e-15);
    }
    // A yaw of 90 turns Babylon's +Z (north) to +X (east).
    expectVec(rotate(vec3(), yawQuaternion(quat(), 90), [0, 0, 1]), [1, 0, 0], 1e-15);
  });

  it('viewFromAxes recovers (az, alt, roll) from the rig basis: the XR pose path end to end', () => {
    // A Babylon rig quaternion of a known camera pose -> ENU basis -> the pose the sensors would
    // publish for the same view; the yaw correction adds to the azimuth alone.
    const f = vec3();
    const r = vec3();
    const u = vec3();
    const pose: ViewPose = { az: NaN, alt: NaN, roll: NaN };
    const random = rng(1309);
    for (let i = 0; i < 200; i += 1) {
      const az = 360 * random();
      const alt = -85 + 170 * random();
      const roll = -179 + 358 * random();
      const delta = -180 + 360 * random();
      basisFromBabylonQuaternion(f, r, u, babylonQuaternionOf(az, alt, roll));
      expect(viewFromAxes(pose, f, u)).toBe(pose);
      expect(angleDiff(pose.az, az)).toBeLessThan(1e-9);
      expect(Math.abs(pose.alt - alt)).toBeLessThan(1e-9);
      expect(angleDiff(pose.roll, roll)).toBeLessThan(1e-9);
      basisFromBabylonQuaternion(
        f,
        r,
        u,
        applyYaw(quat(), delta, babylonQuaternionOf(az, alt, roll)),
      );
      viewFromAxes(pose, f, u);
      expect(angleDiff(pose.az, az + delta)).toBeLessThan(1e-9);
      expect(Math.abs(pose.alt - alt)).toBeLessThan(1e-9);
      expect(angleDiff(pose.roll, roll)).toBeLessThan(1e-9);
    }
    // The gimbal band: a rig looking at the zenith with its screen top toward the east reads
    // az 90 + 180, roll 0; toward the nadir az 90, roll 0 (the rule `viewFromPose` shares).
    viewFromAxes(pose, [0, 0, 1], [1, 0, 0]);
    expect(pose.alt).toBeCloseTo(90, 12);
    expect(pose.az).toBeCloseTo(270, 12);
    expect(pose.roll).toBe(0);
    viewFromAxes(pose, [0, 0, -1], [1, 0, 0]);
    expect(pose.alt).toBeCloseTo(-90, 12);
    expect(pose.az).toBeCloseTo(90, 12);
    expect(pose.roll).toBe(0);
    // A rounded-off forward component is clamped before asin.
    viewFromAxes(pose, [0, 0, 1 + 1e-12], [0, 1, 0]);
    expect(pose.alt).toBe(90);
  });

  it('yawCorrectionDeg wraps to (-180, 180]', () => {
    expect(yawCorrectionDeg(10, 350)).toBeCloseTo(20, 12);
    expect(yawCorrectionDeg(350, 10)).toBeCloseTo(-20, 12);
    expect(yawCorrectionDeg(180, 0)).toBe(180);
    expect(yawCorrectionDeg(0, 180)).toBe(180);
    expect(yawCorrectionDeg(90, 90)).toBe(0);
    expect(yawCorrectionDeg(270.5, 90)).toBeCloseTo(-179.5, 12);
    expect(wrapSigned180Deg(-180)).toBe(180);
    expect(wrapSigned180Deg(190)).toBe(-170);
    expect(wrapSigned180Deg(-170)).toBe(-170);
    expect(wrapSigned180Deg(360)).toBe(0);
    expect(Object.is(wrapSigned180Deg(0), -0)).toBe(false);
  });

  it('fovAspectFromProjection reads a symmetric perspective matrix', () => {
    const fov = 70 * DEG;
    const aspect = 16 / 9;
    const m5 = 1 / Math.tan(fov / 2);
    const m = new Float32Array(16);
    m[0] = m5 / aspect;
    m[5] = m5;
    m[10] = -1.001;
    m[11] = -1;
    m[14] = -2.002;
    const out: FovAspect = { fovRad: NaN, aspect: NaN };
    expect(fovAspectFromProjection(out, m)).toBe(out);
    expect(out.fovRad).toBeCloseTo(fov, 6);
    expect(out.aspect).toBeCloseTo(aspect, 6);
    const exact: number[] = [m5 / aspect, 0, 0, 0, 0, m5];
    fovAspectFromProjection(out, exact);
    expect(out.fovRad).toBeCloseTo(fov, 12);
    expect(out.aspect).toBeCloseTo(aspect, 12);
    expect(() => fovAspectFromProjection(out, [1, 0, 0, 0, 0])).toThrow(RangeError);
  });
});

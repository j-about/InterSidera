// @vitest-environment node
// Reference frames (plan D72, ADR-0009): the single ENU -> Babylon mapping (az=0 -> +Z, az=90 ->
// +X, alt=90 -> +Y, brief l.60), the camera rotation, the Sun of the Greenwich window against the
// Horizons row, the pinhole projection round trip, equatorial coordinates and the J2000 ecliptic.

import { loadFramesFixture, loadHorizonsCases } from '../../test/fixtures';
import type { AltAz, RaDec, ScreenPoint } from './frames';
import {
  DEG,
  ECLIPTIC_OBLIQUITY_J2000_ARCSEC,
  MAX_CAMERA_ALT_DEG,
  MAX_FOV_DEG,
  MIN_FOV_DEG,
  RAD,
  SKY_RADIUS,
  altAzToEnu,
  altitudeDeg,
  azimuthDeg,
  babylonToEnu,
  basisFromBabylonQuaternion,
  cameraBasis,
  cameraRotationFor,
  clampCameraAltDeg,
  clampFovDeg,
  dirFromRaDec,
  directionToScreen,
  dragDeltaDeg,
  eclipticPoleIcrf,
  enuToAltAz,
  enuToBabylon,
  enuToBabylonMatrix,
  raDecFromDir,
  screenToDirection,
  wrapAzimuthDeg,
  wrapSignedDeg,
} from './frames';
import { fromAxisAngle, multiplyQ, rotate } from './quaternion';
import type { Quat, Vec3 } from './typed';
import { at, vec3 } from './typed';
import { arcsecBetween3, length3 } from './vec3';

/** Deterministic PRNG (mulberry32). */
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

/** Apply a Babylon-layout matrix to a row vector: `x'_j = sum_i v_i m[4 i + j]` (w = 1). */
function applyMatrix(m: Float32Array, v: Vec3): Vec3 {
  const out = vec3();
  for (let j = 0; j < 3; j += 1) {
    out[j] = v[0] * at(m, j) + v[1] * at(m, 4 + j) + v[2] * at(m, 8 + j) + at(m, 12 + j);
  }
  return out;
}

function expectVec(actual: Vec3, expected: Vec3, digits = 12): void {
  expect(actual[0]).toBeCloseTo(expected[0], digits);
  expect(actual[1]).toBeCloseTo(expected[1], digits);
  expect(actual[2]).toBeCloseTo(expected[2], digits);
}

describe('constants', () => {
  it('match the brief', () => {
    expect(SKY_RADIUS).toBe(1000);
    expect(DEG * RAD).toBeCloseTo(1, 15);
    expect(MAX_CAMERA_ALT_DEG).toBe(89.99);
    expect(MIN_FOV_DEG).toBe(1);
    expect(MAX_FOV_DEG).toBe(120);
  });
});

describe('altAzToEnu / enuToAltAz', () => {
  it('places the cardinal directions and the zenith', () => {
    expectVec(altAzToEnu(vec3(), 0, 0), [0, 1, 0]);
    expectVec(altAzToEnu(vec3(), 0, 90), [1, 0, 0]);
    expectVec(altAzToEnu(vec3(), 0, 180), [0, -1, 0]);
    expectVec(altAzToEnu(vec3(), 0, 270), [-1, 0, 0]);
    expectVec(altAzToEnu(vec3(), 90, 123), [0, 0, 1]);
    expectVec(altAzToEnu(vec3(), -90, 0), [0, 0, -1]);
  });

  it('round-trips through enuToAltAz', () => {
    const next = rng(21);
    const out: AltAz = { alt: 0, az: 0 };
    for (let k = 0; k < 200; k += 1) {
      const alt = next() * 178 - 89;
      const az = next() * 360;
      const v = altAzToEnu(vec3(), alt, az);
      expect(length3(v)).toBeCloseTo(1, 15);
      expect(enuToAltAz(out, v[0], v[1], v[2])).toBe(out);
      expect(out.alt).toBeCloseTo(alt, 10);
      expect(out.az).toBeCloseTo(az, 10);
    }
  });

  it('altitudeDeg clamps rounding and returns 0 for a zero vector; azimuth is in [0, 360)', () => {
    expect(altitudeDeg(0, 0, 1)).toBe(90);
    expect(altitudeDeg(0, 0, -2)).toBe(-90);
    expect(altitudeDeg(0, 0, 0)).toBe(0);
    expect(altitudeDeg(1, 0, 1)).toBeCloseTo(45, 12);
    expect(azimuthDeg(0, 1)).toBe(0);
    expect(azimuthDeg(1, 0)).toBe(90);
    expect(azimuthDeg(-1, 0)).toBe(270);
    expect(azimuthDeg(-1e-12, 1)).toBeCloseTo(360, 6);
    expect(azimuthDeg(-1e-12, 1)).toBeLessThan(360);
  });
});

describe('wrapAzimuthDeg / clamps', () => {
  it('wraps into [0, 360) and never returns -0 or 360', () => {
    expect(wrapAzimuthDeg(0)).toBe(0);
    expect(wrapAzimuthDeg(360)).toBe(0);
    expect(wrapAzimuthDeg(-10)).toBe(350);
    expect(wrapAzimuthDeg(725)).toBe(5);
    expect(Object.is(wrapAzimuthDeg(-0), 0)).toBe(true);
    // -1e-20 + 360 rounds to exactly 360: the `>= 360` guard maps it to 0.
    expect(wrapAzimuthDeg(-1e-20)).toBe(0);
    expect(wrapAzimuthDeg(359.9)).toBeCloseTo(359.9, 12);
  });

  it('clamps the camera altitude and the field of view (VIEW-1, plan D72)', () => {
    expect(clampCameraAltDeg(95)).toBe(89.99);
    expect(clampCameraAltDeg(-95)).toBe(-89.99);
    expect(clampCameraAltDeg(12.5)).toBe(12.5);
    expect(clampFovDeg(0.2)).toBe(1);
    expect(clampFovDeg(300)).toBe(120);
    expect(clampFovDeg(60)).toBe(60);
  });
});

describe('ENU -> Babylon mapping (brief l.60)', () => {
  const matrix = enuToBabylonMatrix();

  it('az=0 -> +Z through enuToBabylon and the matrix', () => {
    const north = altAzToEnu(vec3(), 0, 0);
    expectVec(enuToBabylon(vec3(), north[0], north[1], north[2]), [0, 0, 1]);
    expectVec(applyMatrix(matrix, north), [0, 0, 1]);
  });

  it('az=90 -> +X', () => {
    const east = altAzToEnu(vec3(), 0, 90);
    expectVec(enuToBabylon(vec3(), east[0], east[1], east[2]), [1, 0, 0]);
    expectVec(applyMatrix(matrix, east), [1, 0, 0]);
  });

  it('alt=90 -> +Y', () => {
    const up = altAzToEnu(vec3(), 90, 0);
    expectVec(enuToBabylon(vec3(), up[0], up[1], up[2]), [0, 1, 0]);
    expectVec(applyMatrix(matrix, up), [0, 1, 0]);
  });

  it('the matrix is the symmetric reflection P (determinant -1, no translation)', () => {
    expect(matrix).toHaveLength(16);
    expect(Array.from(matrix)).toEqual([1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1]);
    // Determinant of the upper 3x3 permutation swapping y and z.
    expect(at(matrix, 0) * (at(matrix, 5) * at(matrix, 10) - at(matrix, 6) * at(matrix, 9))).toBe(
      -1,
    );
  });

  it('babylonToEnu inverts enuToBabylon', () => {
    const v: Vec3 = [0.1, 0.2, 0.3];
    const b = enuToBabylon(vec3(), v[0], v[1], v[2]);
    expect(babylonToEnu(vec3(), b[0], b[1], b[2])).toEqual(v);
  });
});

describe('cameraRotationFor', () => {
  it('yaw = azimuth, pitch = -altitude, roll 0 (Babylon TargetCamera, plan D72)', () => {
    expect(cameraRotationFor(vec3(), 0, 0)).toEqual([-0, 0, 0]);
    const r = cameraRotationFor(vec3(), 90, 30);
    expect(r[0]).toBeCloseTo(-30 * DEG, 15);
    expect(r[1]).toBeCloseTo(90 * DEG, 15);
    expect(r[2]).toBe(0);
  });

  it('clamps the pitch and wraps the yaw', () => {
    const r = cameraRotationFor(vec3(), 370, 95);
    expect(r[0]).toBeCloseTo(-89.99 * DEG, 15);
    expect(r[1]).toBeCloseTo(10 * DEG, 12);
  });
});

describe('horizon quaternion parity with Horizons (D37, plan D88)', () => {
  it('rotates the Sun of the Greenwich window sample 0 within 1 arcsec of the Horizons row', () => {
    const frames = loadFramesFixture();
    const w = frames.windows.find((x) => x.observer === 'earth' && x.site.id === 'greenwich');
    if (w === undefined) {
      throw new Error('no Greenwich window in skyfield_frames.json');
    }
    const q = w.horizon_q[0];
    const sun = w.bodies.sun?.dir[0];
    if (q === undefined || sun === undefined) {
      throw new Error('missing Greenwich sample 0');
    }
    const row = loadHorizonsCases('greenwich', 'sun').find((c) => c.tt === w.tt0);
    if (row === undefined) {
      throw new Error(`no Horizons row for greenwich/sun at tt ${String(w.tt0)}`);
    }
    if (row.az_deg === null || row.el_deg === null) {
      throw new Error('the Greenwich Sun row has no azimuth or elevation');
    }
    expect(w.tt0).toBe(2460409.25);
    expect(row.az_deg).toBeCloseTo(274.200193786, 9);
    expect(row.el_deg).toBeCloseTo(6.359375134, 9);
    const enu = rotate(vec3(), q, sun);
    const reference = altAzToEnu(vec3(), row.el_deg, row.az_deg);
    // Measured 2026-09-06: 0.43 arcsec (Horizons airless apparent vs Skyfield apparent).
    expect(arcsecBetween3(enu, reference)).toBeLessThanOrEqual(1);
    const altaz = enuToAltAz({ alt: 0, az: 0 }, enu[0], enu[1], enu[2]);
    expect(Math.abs(altaz.alt - row.el_deg) * 3600).toBeLessThanOrEqual(1);
    expect(Math.abs(altaz.az - row.az_deg) * 3600 * Math.cos(row.el_deg * DEG)).toBeLessThanOrEqual(
      1,
    );
  });
});

describe('screenToDirection / directionToScreen', () => {
  const width = 1280;
  const height = 720;

  it('maps the screen centre to the view direction and the axes the Babylon way', () => {
    const out: AltAz = { alt: 0, az: 0 };
    screenToDirection(out, width / 2, height / 2, width, height, 60, 45, 20);
    expect(out.az).toBeCloseTo(45, 10);
    expect(out.alt).toBeCloseTo(20, 10);
    // Right of centre -> larger azimuth (clockwise from above), above centre -> higher altitude.
    screenToDirection(out, width * 0.75, height / 2, width, height, 60, 45, 0);
    expect(out.az).toBeGreaterThan(45);
    expect(out.alt).toBeCloseTo(0, 10);
    screenToDirection(out, width / 2, height * 0.25, width, height, 60, 45, 0);
    expect(out.alt).toBeGreaterThan(0);
    expect(out.az).toBeCloseTo(45, 10);
    // Vertical field of view: the top edge is exactly fov/2 above the view direction.
    screenToDirection(out, width / 2, 0, width, height, 60, 0, 0);
    expect(out.alt).toBeCloseTo(30, 10);
    expect(out.az).toBeCloseTo(0, 10);
  });

  it('projects the view direction to the centre, right = +x, up = -y, and rejects the back', () => {
    const p: ScreenPoint = { x: NaN, y: NaN };
    expect(directionToScreen(p, 20, 45, width, height, 60, 45, 20)).toBe(true);
    expect(p.x).toBeCloseTo(width / 2, 9);
    expect(p.y).toBeCloseTo(height / 2, 9);
    expect(directionToScreen(p, 0, 50, width, height, 60, 45, 0)).toBe(true);
    expect(p.x).toBeGreaterThan(width / 2);
    expect(p.y).toBeCloseTo(height / 2, 9);
    expect(directionToScreen(p, 10, 45, width, height, 60, 45, 0)).toBe(true);
    expect(p.y).toBeLessThan(height / 2);
    expect(p.x).toBeCloseTo(width / 2, 9);
    // The horizon at the bottom edge for a 60 degree vertical field looking 30 degrees up.
    expect(directionToScreen(p, 0, 0, width, height, 60, 0, 30)).toBe(true);
    expect(p.y).toBeCloseTo(height, 9);
    p.x = -1;
    expect(directionToScreen(p, 0, 225, width, height, 60, 45, 0)).toBe(false);
    expect(p.x).toBe(-1);
    expect(directionToScreen(p, 0, 135, width, height, 60, 45, 0)).toBe(false);
  });

  it('round-trips within 1e-9 for many random views and pixels', () => {
    const next = rng(22);
    const dir: AltAz = { alt: 0, az: 0 };
    const p: ScreenPoint = { x: 0, y: 0 };
    for (let k = 0; k < 500; k += 1) {
      const w = 320 + Math.floor(next() * 2000);
      const h = 240 + Math.floor(next() * 1400);
      const fov = 1 + next() * 119;
      const viewAz = next() * 360;
      const viewAlt = next() * 179.98 - 89.99;
      const px = next() * w;
      const py = next() * h;
      screenToDirection(dir, px, py, w, h, fov, viewAz, viewAlt);
      expect(directionToScreen(p, dir.alt, dir.az, w, h, fov, viewAz, viewAlt)).toBe(true);
      expect(Math.abs(p.x - px)).toBeLessThan(1e-9);
      expect(Math.abs(p.y - py)).toBeLessThan(1e-9);
    }
  });
});

describe('dirFromRaDec / raDecFromDir', () => {
  it('places the equinox, the pole and round-trips with ra in [0, 360)', () => {
    expectVec(dirFromRaDec(vec3(), 0, 0), [1, 0, 0]);
    expectVec(dirFromRaDec(vec3(), 90, 0), [0, 1, 0]);
    expectVec(dirFromRaDec(vec3(), 0, 90), [0, 0, 1]);
    const next = rng(23);
    const out: RaDec = { ra: 0, dec: 0 };
    for (let k = 0; k < 200; k += 1) {
      const ra = next() * 360;
      const dec = next() * 178 - 89;
      const v = dirFromRaDec(vec3(), ra, dec);
      raDecFromDir(out, v);
      expect(out.ra).toBeCloseTo(ra, 10);
      expect(out.dec).toBeCloseTo(dec, 10);
    }
    raDecFromDir(out, [1, -1e-12, 0]);
    expect(out.ra).toBeLessThan(360);
    expect(out.ra).toBeGreaterThan(359.9);
    // Returns `out` like every other kernel.
    expect(raDecFromDir(out, [0, 0, 2])).toBe(out);
    expect(out.dec).toBe(90);
  });
});

describe('eclipticPoleIcrf', () => {
  it('is the J2000 ecliptic north pole at RA 270, Dec 66.56 (plan D72, Q29)', () => {
    expect(ECLIPTIC_OBLIQUITY_J2000_ARCSEC).toBe(84381.406);
    const pole = eclipticPoleIcrf(vec3());
    expect(length3(pole)).toBeCloseTo(1, 15);
    const out: RaDec = { ra: 0, dec: 0 };
    raDecFromDir(out, pole);
    expect(out.ra).toBeCloseTo(270, 10);
    expect(out.dec).toBeCloseTo(90 - 84381.406 / 3600, 10);
    expect(out.dec).toBeCloseTo(66.56, 2);
    // Perpendicular to the equinox axis, tilted toward -Y.
    expect(pole[0]).toBe(0);
    expect(pole[1]).toBeLessThan(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Roll (plan D119): the trailing `rollDeg` of the camera functions, the Babylon quaternion basis
// pinned against `cameraRotationFor`, the drag rule and the signed wrap.

describe('roll (plan D119)', () => {
  it('cameraRotationFor writes z = -roll in radians and +0 for a zero roll', () => {
    const r = cameraRotationFor(vec3(), 45, 10, 30);
    expect(r[0]).toBeCloseTo(-10 * DEG, 15);
    expect(r[1]).toBeCloseTo(45 * DEG, 15);
    expect(r[2]).toBeCloseTo(-30 * DEG, 15);
    expect(Object.is(cameraRotationFor(vec3(), 45, 10, 0)[2], 0)).toBe(true);
    expect(Object.is(cameraRotationFor(vec3(), 45, 10)[2], 0)).toBe(true);
    expect(cameraRotationFor(vec3(), 0, 0, -90)[2]).toBeCloseTo(Math.PI / 2, 15);
  });

  it('roll 90 looking north points the screen top east and the screen right down', () => {
    const f = vec3();
    const right = vec3();
    const up = vec3();
    cameraBasis(f, right, up, 0, 0, 90);
    expectVec(f, [0, 1, 0]);
    expectVec(up, [1, 0, 0]);
    expectVec(right, [0, 0, -1]);
    // Roll 0 keeps today's basis exactly: right east, up the zenith.
    cameraBasis(f, right, up, 0, 0);
    expectVec(right, [1, 0, 0]);
    expectVec(up, [0, 0, 1]);
    cameraBasis(f, right, up, 0, 0, 0);
    expectVec(right, [1, 0, 0]);
    expectVec(up, [0, 0, 1]);
    // Roll 180 flips both axes; -90 mirrors +90.
    cameraBasis(f, right, up, 0, 0, 180);
    expectVec(right, [-1, 0, 0]);
    expectVec(up, [0, 0, -1]);
    cameraBasis(f, right, up, 0, 0, -90);
    expectVec(up, [-1, 0, 0]);
    expectVec(right, [0, 0, 1]);
  });

  it('keeps the basis orthonormal with up = right x forward for random views and rolls', () => {
    const next = rng(31);
    const f = vec3();
    const right = vec3();
    const up = vec3();
    const f0 = vec3();
    const right0 = vec3();
    const up0 = vec3();
    for (let k = 0; k < 200; k += 1) {
      const az = next() * 360;
      const alt = next() * 179.98 - 89.99;
      const roll = next() * 360 - 180;
      cameraBasis(f, right, up, az, alt, roll);
      cameraBasis(f0, right0, up0, az, alt);
      expect(length3(f)).toBeCloseTo(1, 12);
      expect(length3(right)).toBeCloseTo(1, 12);
      expect(length3(up)).toBeCloseTo(1, 12);
      expect(f[0] * right[0] + f[1] * right[1] + f[2] * right[2]).toBeCloseTo(0, 12);
      expect(f[0] * up[0] + f[1] * up[1] + f[2] * up[2]).toBeCloseTo(0, 12);
      expect(right[0] * up[0] + right[1] * up[1] + right[2] * up[2]).toBeCloseTo(0, 12);
      // The roll leaves forward alone and rotates right and up in their own plane: the
      // convention `roll = atan2(up . right0, up . up0)` of plan D117 recovers the input.
      expectVec(f, f0);
      const dotR = up[0] * right0[0] + up[1] * right0[1] + up[2] * right0[2];
      const dotU = up[0] * up0[0] + up[1] * up0[1] + up[2] * up0[2];
      expect(Math.atan2(dotR, dotU) * RAD).toBeCloseTo(roll, 9);
    }
  });

  it('with roll +90 the zenith side of the field lands on the left edge, with -90 on the right', () => {
    // Square canvas, 60 degree field, looking north at the horizon: a direction 30 degrees up
    // (the top edge without roll) sits exactly on a side edge once the camera is rolled.
    const p: ScreenPoint = { x: NaN, y: NaN };
    expect(directionToScreen(p, 30, 0, 600, 600, 60, 0, 0)).toBe(true);
    expect(p.x).toBeCloseTo(300, 9);
    expect(p.y).toBeCloseTo(0, 9);
    expect(directionToScreen(p, 30, 0, 600, 600, 60, 0, 0, 90)).toBe(true);
    expect(p.x).toBeCloseTo(0, 9);
    expect(p.y).toBeCloseTo(300, 9);
    expect(directionToScreen(p, 30, 0, 600, 600, 60, 0, 0, -90)).toBe(true);
    expect(p.x).toBeCloseTo(600, 9);
    expect(p.y).toBeCloseTo(300, 9);
    // The nadir side goes the other way, and the view centre stays put under any roll.
    expect(directionToScreen(p, -30, 0, 600, 600, 60, 0, 0, 90)).toBe(true);
    expect(p.x).toBeCloseTo(600, 9);
    expect(directionToScreen(p, 0, 0, 600, 600, 60, 0, 0, 123)).toBe(true);
    expect(p.x).toBeCloseTo(300, 9);
    expect(p.y).toBeCloseTo(300, 9);
    // The same through screenToDirection: the left edge centre is the zenith side with roll +90.
    const d: AltAz = { alt: 0, az: 0 };
    screenToDirection(d, 0, 300, 600, 600, 60, 0, 0, 90);
    expect(d.alt).toBeCloseTo(30, 9);
    expect(d.az).toBeCloseTo(0, 9);
  });

  it('round-trips screenToDirection and directionToScreen within 1e-9 under a random roll', () => {
    const next = rng(32);
    const dir: AltAz = { alt: 0, az: 0 };
    const p: ScreenPoint = { x: 0, y: 0 };
    for (let k = 0; k < 500; k += 1) {
      const w = 320 + Math.floor(next() * 2000);
      const h = 240 + Math.floor(next() * 1400);
      const fov = 1 + next() * 119;
      const viewAz = next() * 360;
      const viewAlt = next() * 179.98 - 89.99;
      const roll = next() * 360 - 180;
      const px = next() * w;
      const py = next() * h;
      screenToDirection(dir, px, py, w, h, fov, viewAz, viewAlt, roll);
      expect(directionToScreen(p, dir.alt, dir.az, w, h, fov, viewAz, viewAlt, roll)).toBe(true);
      expect(Math.abs(p.x - px)).toBeLessThan(1e-9);
      expect(Math.abs(p.y - py)).toBeLessThan(1e-9);
    }
  });
});

describe('basisFromBabylonQuaternion (plan D119, D130)', () => {
  /**
   * Babylon 9.25 `Quaternion.RotationYawPitchRollToRef` transcribed from `Maths/math.vector.ts`:
   * the reference the composition below is pinned against (yaw about +Y, pitch about +X, roll
   * about +Z, in Babylon's left-handed frame).
   */
  function babylonYawPitchRoll(yaw: number, pitch: number, roll: number): Quat {
    const halfRoll = roll * 0.5;
    const halfPitch = pitch * 0.5;
    const halfYaw = yaw * 0.5;
    const sinRoll = Math.sin(halfRoll);
    const cosRoll = Math.cos(halfRoll);
    const sinPitch = Math.sin(halfPitch);
    const cosPitch = Math.cos(halfPitch);
    const sinYaw = Math.sin(halfYaw);
    const cosYaw = Math.cos(halfYaw);
    return [
      cosYaw * sinPitch * cosRoll + sinYaw * cosPitch * sinRoll,
      sinYaw * cosPitch * cosRoll - cosYaw * sinPitch * sinRoll,
      cosYaw * cosPitch * sinRoll - sinYaw * sinPitch * cosRoll,
      cosYaw * cosPitch * cosRoll + sinYaw * sinPitch * sinRoll,
    ];
  }

  /** The Hamilton composition `qy(yaw) qx(pitch) qz(roll)` of a `cameraRotationFor` triple. */
  function cameraQuaternion(rotation: Vec3): Quat {
    const qy = fromAxisAngle([0, 0, 0, 1], [0, 1, 0], rotation[1]);
    const qx = fromAxisAngle([0, 0, 0, 1], [1, 0, 0], rotation[0]);
    const qz = fromAxisAngle([0, 0, 0, 1], [0, 0, 1], rotation[2]);
    return multiplyQ([0, 0, 0, 1], multiplyQ([0, 0, 0, 1], qy, qx), qz);
  }

  it('the Hamilton order qy(yaw) qx(pitch) qz(roll) reproduces Babylon RotationYawPitchRoll', () => {
    const next = rng(33);
    for (let k = 0; k < 100; k += 1) {
      const yaw = (next() * 2 - 1) * Math.PI;
      const pitch = (next() * 2 - 1) * (Math.PI / 2);
      const roll = (next() * 2 - 1) * Math.PI;
      const reference = babylonYawPitchRoll(yaw, pitch, roll);
      const composed = cameraQuaternion([pitch, yaw, roll]);
      for (let i = 0; i < 4; i += 1) {
        expect(at(composed, i)).toBeCloseTo(at(reference, i), 14);
      }
    }
  });

  it('returns north, east and the zenith for the three cardinal camera rotations', () => {
    const f = vec3();
    const right = vec3();
    const up = vec3();
    const out: AltAz = { alt: 0, az: 0 };
    basisFromBabylonQuaternion(f, right, up, cameraQuaternion(cameraRotationFor(vec3(), 0, 0)));
    expectVec(f, [0, 1, 0]);
    expectVec(right, [1, 0, 0]);
    expectVec(up, [0, 0, 1]);
    basisFromBabylonQuaternion(f, right, up, cameraQuaternion(cameraRotationFor(vec3(), 90, 0)));
    expectVec(f, [1, 0, 0]);
    expectVec(right, [0, -1, 0]);
    expectVec(up, [0, 0, 1]);
    basisFromBabylonQuaternion(f, right, up, cameraQuaternion(cameraRotationFor(vec3(), 0, 90)));
    // The pitch is clamped to 89.99 degrees by `cameraRotationFor`.
    enuToAltAz(out, f[0], f[1], f[2]);
    expect(out.alt).toBeCloseTo(MAX_CAMERA_ALT_DEG, 9);
    expect(out.az).toBeCloseTo(0, 9);
    expect(f[2]).toBeCloseTo(1, 7);
    expectVec(right, [1, 0, 0]);
    // up0 = right0 x forward = (0, -sin alt, cos alt) when looking north.
    expectVec(up, [0, -Math.sin(MAX_CAMERA_ALT_DEG * DEG), Math.cos(MAX_CAMERA_ALT_DEG * DEG)]);
    // The identity quaternion is the identity camera: north, east, zenith.
    basisFromBabylonQuaternion(f, right, up, [0, 0, 0, 1]);
    expectVec(f, [0, 1, 0]);
    expectVec(right, [1, 0, 0]);
    expectVec(up, [0, 0, 1]);
  });

  it('matches cameraBasis(az, alt, roll) within 1e-9 degrees for random rotations', () => {
    const next = rng(34);
    const f = vec3();
    const right = vec3();
    const up = vec3();
    const f0 = vec3();
    const right0 = vec3();
    const up0 = vec3();
    const out: AltAz = { alt: 0, az: 0 };
    for (let k = 0; k < 200; k += 1) {
      const az = next() * 360;
      const alt = next() * 179 - 89.5;
      const roll = next() * 360 - 180;
      basisFromBabylonQuaternion(
        f,
        right,
        up,
        cameraQuaternion(cameraRotationFor(vec3(), az, alt, roll)),
      );
      cameraBasis(f0, right0, up0, az, alt, roll);
      expectVec(f, f0, 9);
      expectVec(right, right0, 9);
      expectVec(up, up0, 9);
      enuToAltAz(out, f[0], f[1], f[2]);
      expect(out.az).toBeCloseTo(az, 9);
      expect(out.alt).toBeCloseTo(alt, 9);
    }
  });
});

describe('dragDeltaDeg (plan D120)', () => {
  it('turns a drag to the right into a negative azimuth change scaled by fov / height', () => {
    expect(dragDeltaDeg(100, 60, 600)).toBeCloseTo(-10, 12);
    expect(dragDeltaDeg(-30, 60, 600)).toBeCloseTo(3, 12);
    expect(dragDeltaDeg(50, 20, 400)).toBeCloseTo(-2.5, 12);
    expect(Object.is(dragDeltaDeg(0, 60, 600), 0)).toBe(true);
  });

  it('gives 0 for a zero, negative or unknown height', () => {
    expect(dragDeltaDeg(100, 60, 0)).toBe(0);
    expect(dragDeltaDeg(100, 60, -5)).toBe(0);
    expect(dragDeltaDeg(100, 60, NaN)).toBe(0);
  });
});

describe('wrapSignedDeg', () => {
  it('wraps into [-180, 180) and never returns -0', () => {
    expect(wrapSignedDeg(190)).toBe(-170);
    expect(wrapSignedDeg(-190)).toBe(170);
    expect(wrapSignedDeg(180)).toBe(-180);
    expect(wrapSignedDeg(-180)).toBe(-180);
    expect(wrapSignedDeg(540)).toBe(-180);
    expect(wrapSignedDeg(359)).toBe(-1);
    expect(wrapSignedDeg(45)).toBe(45);
    expect(wrapSignedDeg(-45)).toBe(-45);
    expect(wrapSignedDeg(360)).toBe(0);
    expect(Object.is(wrapSignedDeg(0), 0)).toBe(true);
    expect(Object.is(wrapSignedDeg(-0), 0)).toBe(true);
    expect(Object.is(wrapSignedDeg(720), 0)).toBe(true);
    expect(wrapSignedDeg(179.999)).toBeCloseTo(179.999, 9);
  });
});

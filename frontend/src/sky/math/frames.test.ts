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
  cameraRotationFor,
  clampCameraAltDeg,
  clampFovDeg,
  dirFromRaDec,
  directionToScreen,
  eclipticPoleIcrf,
  enuToAltAz,
  enuToBabylon,
  enuToBabylonMatrix,
  raDecFromDir,
  screenToDirection,
  wrapAzimuthDeg,
} from './frames';
import { rotate } from './quaternion';
import type { Vec3 } from './typed';
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

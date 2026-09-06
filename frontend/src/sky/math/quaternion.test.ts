// @vitest-environment node
// Hamilton quaternions (plan D71, D74): rotation identities against a matrix, composition, and
// slerp parity with the `skyfield_frames.json` windows (half-step slerp within 0.01 arcsec).

import { loadFramesFixture } from '../../test/fixtures';
import {
  conjugateQ,
  copyQ,
  dotQ,
  fromAxisAngle,
  lengthQ,
  multiplyQ,
  normalizeQ,
  rotate,
  rotateInverse,
  rotationAngle,
  setQ,
  slerp,
} from './quaternion';
import type { Quat, ReadonlyQuat, Vec3 } from './typed';
import { quat, vec3 } from './typed';
import { ARCSEC_PER_RAD, arcsecBetween3, length3, normalize3 } from './vec3';

/** Deterministic PRNG (mulberry32) so a failure reproduces. */
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

function randomUnitQuat(next: () => number): Quat {
  const q: Quat = [next() - 0.5, next() - 0.5, next() - 0.5, next() - 0.5];
  return normalizeQ(q, q);
}

function randomVec(next: () => number): Vec3 {
  return [next() * 4 - 2, next() * 4 - 2, next() * 4 - 2];
}

/** Rotate `v` with the 3x3 matrix of the unit quaternion `q` (the textbook formula). */
function rotateByMatrix(q: ReadonlyQuat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  const m = [
    [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
  ];
  const row = (r: number[]): number => (r[0] ?? 0) * v[0] + (r[1] ?? 0) * v[1] + (r[2] ?? 0) * v[2];
  return [row(m[0] ?? []), row(m[1] ?? []), row(m[2] ?? [])];
}

const frames = loadFramesFixture();

describe('setQ / copyQ / dotQ / lengthQ / normalizeQ / conjugateQ', () => {
  it('basic accessors', () => {
    const q = quat();
    expect(setQ(q, 1, 2, 3, 4)).toBe(q);
    expect(copyQ(quat(), q)).toEqual([1, 2, 3, 4]);
    expect(dotQ(q, [1, 1, 1, 1])).toBe(10);
    expect(lengthQ([0, 0, 3, 4])).toBe(5);
    const unit = normalizeQ(quat(), [0, 0, 3, 4]);
    expect(unit[2]).toBeCloseTo(0.6, 15);
    expect(unit[3]).toBeCloseTo(0.8, 15);
    expect(lengthQ(unit)).toBeCloseTo(1, 15);
    expect(conjugateQ(quat(), [1, 2, 3, 4])).toEqual([-1, -2, -3, 4]);
  });

  it('normalizeQ throws on a zero or non-finite quaternion', () => {
    expect(() => normalizeQ(quat(), [0, 0, 0, 0])).toThrow(RangeError);
    expect(() => normalizeQ(quat(), [NaN, 0, 0, 1])).toThrow(RangeError);
  });
});

describe('rotate', () => {
  it('equals the rotation matrix of the quaternion for random unit quaternions', () => {
    const next = rng(1);
    for (let k = 0; k < 200; k += 1) {
      const q = randomUnitQuat(next);
      const v = randomVec(next);
      const viaQ = rotate(vec3(), q, v);
      const viaM = rotateByMatrix(q, v);
      expect(viaQ[0]).toBeCloseTo(viaM[0], 12);
      expect(viaQ[1]).toBeCloseTo(viaM[1], 12);
      expect(viaQ[2]).toBeCloseTo(viaM[2], 12);
      expect(length3(viaQ)).toBeCloseTo(length3(v), 12);
    }
  });

  it('is aliasing-safe and rotateInverse undoes it', () => {
    const next = rng(2);
    for (let k = 0; k < 50; k += 1) {
      const q = randomUnitQuat(next);
      const v = randomVec(next);
      const copy: Vec3 = [v[0], v[1], v[2]];
      rotate(copy, q, copy);
      expect(copy).toEqual(rotate(vec3(), q, v));
      const back = rotateInverse(vec3(), q, copy);
      expect(back[0]).toBeCloseTo(v[0], 12);
      expect(back[1]).toBeCloseTo(v[1], 12);
      expect(back[2]).toBeCloseTo(v[2], 12);
    }
  });

  it('rotates +X to +Y by 90 degrees about +Z (Hamilton, right-handed)', () => {
    const q = fromAxisAngle(quat(), [0, 0, 1], Math.PI / 2);
    const r = rotate(vec3(), q, [1, 0, 0]);
    expect(r[0]).toBeCloseTo(0, 15);
    expect(r[1]).toBeCloseTo(1, 15);
    expect(r[2]).toBeCloseTo(0, 15);
  });
});

describe('multiplyQ / conjugateQ', () => {
  it('composes: rotate(a * b, v) applies b first, then a', () => {
    const next = rng(3);
    for (let k = 0; k < 50; k += 1) {
      const a = randomUnitQuat(next);
      const b = randomUnitQuat(next);
      const v = randomVec(next);
      const ab = multiplyQ(quat(), a, b);
      const composed = rotate(vec3(), ab, v);
      const stepwise = rotate(vec3(), a, rotate(vec3(), b, v));
      expect(composed[0]).toBeCloseTo(stepwise[0], 12);
      expect(composed[1]).toBeCloseTo(stepwise[1], 12);
      expect(composed[2]).toBeCloseTo(stepwise[2], 12);
    }
  });

  it('q * conj(q) is the identity and multiplyQ is aliasing-safe', () => {
    const q = randomUnitQuat(rng(4));
    const id = multiplyQ(quat(), q, conjugateQ(quat(), q));
    expect(id[0]).toBeCloseTo(0, 15);
    expect(id[1]).toBeCloseTo(0, 15);
    expect(id[2]).toBeCloseTo(0, 15);
    expect(id[3]).toBeCloseTo(1, 15);
    const a = randomUnitQuat(rng(5));
    const b = randomUnitQuat(rng(6));
    const expected = multiplyQ(quat(), a, b);
    const aliased = copyQ(quat(), a);
    multiplyQ(aliased, aliased, b);
    expect(aliased).toEqual(expected);
  });
});

describe('slerp', () => {
  it('reproduces the fixture horizon_q samples at its endpoints', () => {
    for (const w of frames.windows) {
      for (let i = 0; i + 1 < w.n; i += 1) {
        const a = w.horizon_q[i];
        const b = w.horizon_q[i + 1];
        if (a === undefined || b === undefined) {
          throw new Error('missing sample');
        }
        const at0 = slerp(quat(), a, b, 0);
        const at1 = slerp(quat(), a, b, 1);
        expect(rotationAngle(at0, a) * ARCSEC_PER_RAD).toBeLessThan(1e-6);
        expect(rotationAngle(at1, b) * ARCSEC_PER_RAD).toBeLessThan(1e-6);
        expect(lengthQ(at0)).toBeCloseTo(1, 15);
      }
    }
  });

  it('half-step slerp from every second sample is within 0.01 arcsec of the skipped sample', () => {
    // Measured 2026-09-06: 0.002 arcsec (horizon_q and equinox_q of the three windows).
    let worst = 0;
    for (const w of frames.windows) {
      for (const series of [w.horizon_q, w.equinox_q]) {
        for (let i = 0; i + 2 < w.n; i += 2) {
          const a = series[i];
          const mid = series[i + 1];
          const b = series[i + 2];
          if (a === undefined || mid === undefined || b === undefined) {
            throw new Error('missing sample');
          }
          const half = slerp(quat(), a, b, 0.5);
          worst = Math.max(worst, rotationAngle(half, mid) * ARCSEC_PER_RAD);
        }
      }
    }
    expect(worst).toBeLessThanOrEqual(0.01);
  });

  it('flips the sign of b defensively so the short arc is taken (brief l.58)', () => {
    const a = randomUnitQuat(rng(7));
    const b = randomUnitQuat(rng(8));
    const negB: Quat = [-b[0], -b[1], -b[2], -b[3]];
    const straight = slerp(quat(), a, b, 0.3);
    const flipped = slerp(quat(), a, negB, 0.3);
    expect(rotationAngle(straight, flipped)).toBeLessThan(1e-12);
    // The result of the flipped call is the same quaternion up to sign, never the long way round.
    expect(Math.abs(dotQ(straight, flipped))).toBeCloseTo(1, 12);
  });

  it('falls back to a normalised lerp when the arc is tiny', () => {
    const a = randomUnitQuat(rng(9));
    const same = slerp(quat(), a, a, 0.5);
    expect(same).toEqual(a);
    const nearly: Quat = [a[0] + 1e-9, a[1], a[2], a[3]];
    normalizeQ(nearly, nearly);
    const between = slerp(quat(), a, nearly, 0.5);
    expect(lengthQ(between)).toBeCloseTo(1, 15);
    expect(rotationAngle(between, a)).toBeLessThan(2e-9);
  });

  it('extrapolates along the same geodesic for t outside [0, 1] (brief l.69)', () => {
    const a = randomUnitQuat(rng(10));
    const step = fromAxisAngle(quat(), normalize3(vec3(), [1, 2, 3]), 0.01);
    const b = multiplyQ(quat(), step, a);
    const twice = slerp(quat(), a, b, 2);
    const back = slerp(quat(), a, b, -1);
    expect(rotationAngle(twice, a)).toBeCloseTo(0.02, 12);
    expect(rotationAngle(back, a)).toBeCloseTo(0.01, 12);
    expect(rotationAngle(back, b)).toBeCloseTo(0.02, 12);
  });

  it('is aliasing-safe (out may be a)', () => {
    const a = randomUnitQuat(rng(11));
    const b = randomUnitQuat(rng(12));
    const expected = slerp(quat(), a, b, 0.4);
    const aliased = copyQ(quat(), a);
    slerp(aliased, aliased, b, 0.4);
    expect(aliased).toEqual(expected);
  });
});

describe('rotationAngle / fromAxisAngle', () => {
  it('recovers the axis-angle rotation, independent of quaternion sign', () => {
    const axis = normalize3(vec3(), [0.3, -0.4, 0.5]);
    const q = fromAxisAngle(quat(), axis, 0.7);
    expect(lengthQ(q)).toBeCloseTo(1, 15);
    expect(rotationAngle(q, [0, 0, 0, 1])).toBeCloseTo(0.7, 12);
    expect(rotationAngle(q, [0, 0, 0, -1])).toBeCloseTo(0.7, 12);
    const neg: Quat = [-q[0], -q[1], -q[2], -q[3]];
    expect(rotationAngle(neg, [0, 0, 0, 1])).toBeCloseTo(0.7, 12);
    expect(rotationAngle(q, q)).toBeLessThan(1e-15);
  });

  it('resolves tiny angles where acos would not (plan D71)', () => {
    const tiny = 1e-9;
    const q = fromAxisAngle(quat(), [1, 0, 0], tiny);
    expect(rotationAngle(q, [0, 0, 0, 1])).toBeCloseTo(tiny, 18);
    // The rotated vector moves by the same angle.
    const v = rotate(vec3(), q, [0, 1, 0]);
    expect(arcsecBetween3(v, [0, 1, 0])).toBeCloseTo(tiny * ARCSEC_PER_RAD, 9);
  });
});

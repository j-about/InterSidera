// @vitest-environment node
// 3-vector algebra (plan D71): identities, aliasing safety and the `atan2` angle that keeps its
// precision where `acos` saturates.

import type { Vec3 } from './typed';
import {
  ARCSEC_PER_RAD,
  add3,
  addScaled3,
  angleBetween3,
  arcsecBetween3,
  copy3,
  cross3,
  dot3,
  length3,
  normalize3,
  scale3,
  set3,
  sub3,
} from './vec3';

const a: Vec3 = [1, 2, 3];
const b: Vec3 = [-4, 5, 0.5];

describe('vec3 arithmetic', () => {
  it('set3, copy3, add3, sub3, scale3, addScaled3 write into out and return it', () => {
    const out: Vec3 = [0, 0, 0];
    expect(set3(out, 1, 2, 3)).toBe(out);
    expect(out).toEqual([1, 2, 3]);
    expect(copy3(out, b)).toEqual([-4, 5, 0.5]);
    expect(add3(out, a, b)).toEqual([-3, 7, 3.5]);
    expect(sub3(out, a, b)).toEqual([5, -3, 2.5]);
    expect(scale3(out, a, 2)).toEqual([2, 4, 6]);
    expect(addScaled3(out, a, b, 2)).toEqual([-7, 12, 4]);
  });

  it('dot3 and length3', () => {
    expect(dot3(a, b)).toBe(-4 + 10 + 1.5);
    expect(length3([3, 4, 12])).toBe(13);
    expect(ARCSEC_PER_RAD).toBeCloseTo(206264.806247, 6);
  });

  it('cross3 is anticommutative, orthogonal to its inputs and aliasing-safe', () => {
    const ab: Vec3 = [0, 0, 0];
    const ba: Vec3 = [0, 0, 0];
    cross3(ab, a, b);
    cross3(ba, b, a);
    expect(ab).toEqual([2 * 0.5 - 3 * 5, 3 * -4 - 1 * 0.5, 1 * 5 - 2 * -4]);
    expect(ba).toEqual(ab.map((x) => -x));
    expect(dot3(ab, a)).toBeCloseTo(0, 12);
    expect(dot3(ab, b)).toBeCloseTo(0, 12);
    expect(cross3([0, 0, 0], a, a)).toEqual([0, 0, 0]);
    const aliased: Vec3 = [1, 2, 3];
    cross3(aliased, aliased, b);
    expect(aliased).toEqual(ab);
    expect(cross3([0, 0, 0], [1, 0, 0], [0, 1, 0])).toEqual([0, 0, 1]);
  });
});

describe('normalize3', () => {
  it('produces a unit vector, in place when out aliases a', () => {
    const v: Vec3 = [3, 0, 4];
    expect(normalize3(v, v)).toBe(v);
    expect(v[0]).toBeCloseTo(0.6, 15);
    expect(v[1]).toBe(0);
    expect(v[2]).toBeCloseTo(0.8, 15);
    expect(length3(normalize3([0, 0, 0], [1e-9, -2e-9, 2e-9]))).toBeCloseTo(1, 15);
  });

  it('throws RangeError for a zero or non-finite vector', () => {
    expect(() => normalize3([0, 0, 0], [0, 0, 0])).toThrow(RangeError);
    expect(() => normalize3([0, 0, 0], [NaN, 0, 0])).toThrow(RangeError);
    expect(() => normalize3([0, 0, 0], [Infinity, 0, 0])).toThrow(RangeError);
  });
});

describe('angleBetween3', () => {
  it('matches acos away from the poles of acos', () => {
    expect(angleBetween3([1, 0, 0], [0, 1, 0])).toBeCloseTo(Math.PI / 2, 15);
    expect(angleBetween3([1, 0, 0], [-1, 0, 0])).toBeCloseTo(Math.PI, 15);
    expect(angleBetween3([1, 0, 0], [1, 0, 0])).toBe(0);
    expect(angleBetween3([2, 0, 0], [1, 1, 0])).toBeCloseTo(Math.PI / 4, 15);
  });

  it('keeps its precision on nearly parallel unit vectors where acos saturates (plan D71)', () => {
    // 0.01 arcsec = 4.85e-8 rad: `acos(dot)` cannot resolve it (dot rounds to 1 - 1e-15 steps).
    const tiny = 0.01 / ARCSEC_PER_RAD;
    const u: Vec3 = [1, 0, 0];
    const v: Vec3 = [Math.cos(tiny), Math.sin(tiny), 0];
    expect(angleBetween3(u, v)).toBeCloseTo(tiny, 20);
    expect(arcsecBetween3(u, v)).toBeCloseTo(0.01, 9);
    const viaAcos = Math.acos(Math.min(1, dot3(u, v)));
    // acos gives 0 or a value quantised to ~1e-8 rad here: the relative error is large.
    expect(Math.abs(viaAcos - tiny) / tiny).toBeGreaterThan(1e-3);
  });
});

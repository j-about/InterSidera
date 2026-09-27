// @vitest-environment node
// Numeric idiom of plan D71: `at()` throws instead of hiding an out-of-range read behind `?? 0`.

import { at, load3, load4, quat, store3, store4, vec3 } from './typed';

describe('at', () => {
  it('reads plain arrays and typed arrays', () => {
    expect(at([1, 2, 3], 1)).toBe(2);
    expect(at(new Float64Array([4, 5]), 0)).toBe(4);
    expect(at(new Int16Array([7]), 0)).toBe(7);
    // One load site per receiver family (plan D144): every family reads the same value back.
    expect(at(new Float32Array([0.5, -1.25]), 1)).toBe(-1.25);
    expect(at(new Float64Array([1e-300]), 0)).toBe(1e-300);
    expect(at(new Uint32Array([4_000_000_000]), 0)).toBe(4_000_000_000);
    expect(at(new Uint8Array([255]), 0)).toBe(255);
  });

  it('throws RangeError outside the array (plan D71, no `?? 0` fallback)', () => {
    expect(() => at([1, 2, 3], 3)).toThrow(RangeError);
    expect(() => at([1, 2, 3], -1)).toThrow(RangeError);
    expect(() => at(new Float32Array(2), 2)).toThrow(/out of range for length 2/);
    expect(() => at(new Float64Array(1), 1)).toThrow(/out of range for length 1/);
    expect(() => at(new Int32Array(0), 0)).toThrow(/out of range for length 0/);
  });
});

describe('load3 / store3', () => {
  it('round-trips through Float32Array and Float64Array', () => {
    const f64 = new Float64Array(6);
    store3(f64, 3, [1.5, -2.25, 3.125]);
    expect(Array.from(f64)).toEqual([0, 0, 0, 1.5, -2.25, 3.125]);
    expect(load3(vec3(), f64, 3)).toEqual([1.5, -2.25, 3.125]);

    const f32 = new Float32Array(3);
    store3(f32, 0, [0.5, 0.25, -0.125]);
    expect(load3(vec3(), f32, 0)).toEqual([0.5, 0.25, -0.125]);
  });

  it('returns `out` itself', () => {
    const out = vec3();
    expect(load3(out, [9, 8, 7], 0)).toBe(out);
  });

  it('throws when the triple runs past the array', () => {
    // Every operand of the guard (plan D144: one combined check over the three reads).
    expect(() => load3(vec3(), [1, 2], 0)).toThrow(/indices 0\.\.2 out of range for length 2/);
    expect(() => load3(vec3(), new Float64Array(3), 3)).toThrow(RangeError);
    expect(() => load3(vec3(), new Float64Array(3), 2)).toThrow(RangeError);
    expect(() => load3(vec3(), new Float64Array(3), 1)).toThrow(RangeError);
    expect(() => load3(vec3(), new Float32Array(3), -1)).toThrow(RangeError);
  });
});

describe('load4 / store4', () => {
  it('round-trips a quaternion', () => {
    const dst = new Float64Array(8);
    store4(dst, 4, [0.1, 0.2, 0.3, 0.9]);
    expect(load4(quat(), dst, 4)).toEqual([0.1, 0.2, 0.3, 0.9]);
    expect(Array.from(dst.subarray(0, 4))).toEqual([0, 0, 0, 0]);
  });

  it('throws when the quadruple runs past the array', () => {
    expect(() => load4(quat(), new Float32Array(7), 4)).toThrow(
      /indices 4\.\.7 out of range for length 7/,
    );
    expect(() => load4(quat(), new Float64Array(4), 4)).toThrow(RangeError);
    expect(() => load4(quat(), new Float64Array(4), 3)).toThrow(RangeError);
    expect(() => load4(quat(), new Float64Array(4), 2)).toThrow(RangeError);
    expect(() => load4(quat(), new Float64Array(4), 1)).toThrow(RangeError);
  });
});

describe('vec3 / quat', () => {
  it('allocate fresh zero and identity values', () => {
    expect(vec3()).toEqual([0, 0, 0]);
    expect(quat()).toEqual([0, 0, 0, 1]);
    expect(vec3()).not.toBe(vec3());
    expect(quat()).not.toBe(quat());
  });
});

// @vitest-environment node
// Polyline generators of the reference overlays (plan D84): counts, closed circles, unit norms,
// a deterministic basis for every axis, and in-place rotation.

import {
  ALTAZ_GRID_ALT_STEP_DEG,
  ALTAZ_GRID_AZ_STEP_DEG,
  CIRCLE_SEGMENTS,
  EQUATORIAL_GRID_DEC_STEP_DEG,
  EQUATORIAL_GRID_RA_STEP_DEG,
  azimuthArcPoints,
  greatCirclePoints,
  rotatePointsInPlace,
  smallCirclePoints,
} from './lines';
import { fromAxisAngle } from './quaternion';
import type { ReadonlyVec3, Vec3 } from './typed';
import { at, load3, quat, vec3 } from './typed';
import { dot3, length3 } from './vec3';

const UP: ReadonlyVec3 = [0, 0, 1];
const EAST: ReadonlyVec3 = [1, 0, 0];

function pointAt(buf: Float32Array, offset: number, k: number): Vec3 {
  return load3(vec3(), buf, offset + 3 * k);
}

function expectVec(actual: ReadonlyVec3, expected: ReadonlyVec3, digits = 6): void {
  expect(actual[0]).toBeCloseTo(expected[0], digits);
  expect(actual[1]).toBeCloseTo(expected[1], digits);
  expect(actual[2]).toBeCloseTo(expected[2], digits);
}

describe('constants', () => {
  it('grid steps and circle resolution (plan D84)', () => {
    expect(EQUATORIAL_GRID_RA_STEP_DEG).toBe(15);
    expect(EQUATORIAL_GRID_DEC_STEP_DEG).toBe(15);
    expect(ALTAZ_GRID_AZ_STEP_DEG).toBe(15);
    expect(ALTAZ_GRID_ALT_STEP_DEG).toBe(10);
    expect(CIRCLE_SEGMENTS).toBe(180);
  });
});

describe('greatCirclePoints', () => {
  it('writes a closed horizon circle of unit vectors perpendicular to Up', () => {
    const count = CIRCLE_SEGMENTS + 1;
    const buf = new Float32Array(3 * count + 6);
    expect(greatCirclePoints(buf, 3, UP, count)).toBe(3 * count);
    expect(Array.from(buf.subarray(0, 3))).toEqual([0, 0, 0]);
    expect(Array.from(buf.subarray(3 * count + 3))).toEqual([0, 0, 0]);
    for (let k = 0; k < count; k += 1) {
      const p = pointAt(buf, 3, k);
      expect(length3(p)).toBeCloseTo(1, 6);
      expect(p[2]).toBeCloseTo(0, 10);
    }
    expect(pointAt(buf, 3, count - 1)).toEqual(pointAt(buf, 3, 0));
    // 2 degrees between consecutive points.
    const p0 = pointAt(buf, 3, 0);
    const p1 = pointAt(buf, 3, 1);
    expect((Math.acos(dot3(p0, p1)) * 180) / Math.PI).toBeCloseTo(2, 4);
    // A quarter turn later the point is 90 degrees away.
    expect(dot3(p0, pointAt(buf, 3, 45))).toBeCloseTo(0, 6);
  });

  it('draws the meridian through the zenith and the north point for the East normal', () => {
    const buf = new Float32Array(3 * 5);
    greatCirclePoints(buf, 0, EAST, 5);
    for (let k = 0; k < 5; k += 1) {
      expect(pointAt(buf, 0, k)[0]).toBeCloseTo(0, 10);
    }
    // Points are 90 degrees apart: two of them are the poles of the circle's own plane.
    const zeniths = [0, 1, 2, 3].filter((k) => Math.abs(pointAt(buf, 0, k)[2]) > 0.999);
    const norths = [0, 1, 2, 3].filter((k) => Math.abs(pointAt(buf, 0, k)[1]) > 0.999);
    expect(zeniths).toHaveLength(2);
    expect(norths).toHaveLength(2);
  });
});

describe('smallCirclePoints', () => {
  it('keeps every point at the requested angle from the axis and closes the loop', () => {
    const buf = new Float32Array(3 * 37);
    expect(smallCirclePoints(buf, 0, UP, 60, 37)).toBe(111);
    for (let k = 0; k < 37; k += 1) {
      const p = pointAt(buf, 0, k);
      expect(length3(p)).toBeCloseTo(1, 6);
      expect(dot3(p, UP)).toBeCloseTo(Math.cos(Math.PI / 3), 6);
    }
    expect(pointAt(buf, 0, 36)).toEqual(pointAt(buf, 0, 0));
  });

  it('accepts an unnormalised axis and a deterministic basis for every dominant component', () => {
    const buf = new Float32Array(3 * 9);
    for (const axis of [
      [0, 0, 2],
      [3, 0, 0],
      [0, 0.5, 0],
      [1, 1, 0.1],
      [0.2, 1, 1],
    ] as ReadonlyVec3[]) {
      smallCirclePoints(buf, 0, axis, 30, 9);
      const n = length3(axis);
      for (let k = 0; k < 9; k += 1) {
        const p = pointAt(buf, 0, k);
        expect(length3(p)).toBeCloseTo(1, 6);
        expect(dot3(p, axis) / n).toBeCloseTo(Math.cos(Math.PI / 6), 6);
      }
    }
  });

  it('degenerates to the axis itself at 0 degrees', () => {
    const buf = new Float32Array(9);
    smallCirclePoints(buf, 0, UP, 0, 3);
    for (let k = 0; k < 3; k += 1) {
      expectVec(pointAt(buf, 0, k), UP);
    }
  });
});

describe('azimuthArcPoints', () => {
  it('runs from nadir to zenith through the east point at azimuth 90', () => {
    const buf = new Float32Array(3 * 19);
    expect(azimuthArcPoints(buf, 0, 90, -90, 90, 19)).toBe(57);
    expectVec(pointAt(buf, 0, 0), [0, 0, -1]);
    expectVec(pointAt(buf, 0, 9), EAST);
    expectVec(pointAt(buf, 0, 18), UP);
    for (let k = 1; k < 18; k += 1) {
      const p = pointAt(buf, 0, k);
      expect(length3(p)).toBeCloseTo(1, 6);
      expect(p[0]).toBeGreaterThan(0);
      expect(Math.abs(p[1])).toBeLessThan(1e-6);
    }
  });

  it('follows any azimuth and altitude range, e.g. the 10-degree grid rung', () => {
    const buf = new Float32Array(6);
    azimuthArcPoints(buf, 0, 45, 10, 20, 2);
    const a = pointAt(buf, 0, 0);
    const b = pointAt(buf, 0, 1);
    expect(Math.asin(a[2]) * (180 / Math.PI)).toBeCloseTo(10, 5);
    expect(Math.asin(b[2]) * (180 / Math.PI)).toBeCloseTo(20, 5);
    expect(Math.atan2(a[0], a[1]) * (180 / Math.PI)).toBeCloseTo(45, 5);
  });
});

describe('rotatePointsInPlace', () => {
  it('rotates only the addressed vectors by the quaternion', () => {
    const buf = new Float32Array(12);
    buf.set([9, 9, 9, 1, 0, 0, 0, 1, 0, 8, 8, 8]);
    const q = fromAxisAngle(quat(), UP, Math.PI / 2);
    rotatePointsInPlace(buf, 3, 2, q);
    expect(Array.from(buf.subarray(0, 3))).toEqual([9, 9, 9]);
    expect(Array.from(buf.subarray(9))).toEqual([8, 8, 8]);
    expectVec(pointAt(buf, 3, 0), [0, 1, 0]);
    expectVec(pointAt(buf, 3, 1), [-1, 0, 0]);
  });

  it('keeps a rotated great circle on the unit sphere and perpendicular to the rotated normal', () => {
    const count = 25;
    const buf = new Float32Array(3 * count);
    greatCirclePoints(buf, 0, UP, count);
    const q = fromAxisAngle(quat(), EAST, 0.7);
    rotatePointsInPlace(buf, 0, count, q);
    const normal: Vec3 = [0, -Math.sin(0.7), Math.cos(0.7)];
    for (let k = 0; k < count; k += 1) {
      const p = pointAt(buf, 0, k);
      expect(length3(p)).toBeCloseTo(1, 6);
      expect(dot3(p, normal)).toBeCloseTo(0, 6);
    }
  });
});

describe('guards', () => {
  it('rejects fewer than two points, negative offsets and buffers that are too small', () => {
    const buf = new Float32Array(9);
    expect(() => greatCirclePoints(buf, 0, UP, 1)).toThrow(RangeError);
    expect(() => smallCirclePoints(buf, -3, UP, 30, 2)).toThrow(RangeError);
    expect(() => azimuthArcPoints(buf, 3, 0, 0, 90, 3)).toThrow(/exceed a buffer of 9 floats/);
    expect(() => azimuthArcPoints(buf, 0, 0, 0, 90, 3)).not.toThrow();
    expect(at(buf, 8)).toBeCloseTo(1, 6);
  });
});

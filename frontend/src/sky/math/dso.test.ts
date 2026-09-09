// @vitest-environment node
// Deep-sky appearance rules (SKY-3, plan D101): the two limits, the visibility truth table, the
// pixel radius clamp, the on-screen position angle on hand cases and the attribute packing.

import { DSO_TYPES } from '../../state/types';
import { billboardBasis } from './apparent';
import {
  DSO_LINE_WIDTH_PX,
  DSO_MAG_UNKNOWN,
  DSO_MANUAL_LIMIT_OFFSET,
  DSO_MIN_RADIUS_PX,
  DSO_NARROW_FIELD_MAG_LIMIT,
  DSO_SIZE_LIMIT_FRACTION,
  DSO_SYMBOL_TYPES,
  DSO_WIDE_FIELD_MAG_LIMIT,
  dsoMagnitudeLimit,
  dsoMagnitudeLimitForFov,
  dsoPixelRadius,
  dsoSizeLimitArcmin,
  dsoVisible,
  northTangent,
  screenPositionAngle,
  symbolIdOf,
  writeDsoShape,
} from './dso';
import { DEG } from './frames';
import { vec3 } from './typed';
import type { Vec3 } from './typed';
import { length3 } from './vec3';

describe('dsoMagnitudeLimitForFov', () => {
  it('is 7 at 90 degrees and wider, 14 at 1 degree and narrower, logarithmic between', () => {
    expect(DSO_WIDE_FIELD_MAG_LIMIT).toBe(7);
    expect(DSO_NARROW_FIELD_MAG_LIMIT).toBe(14);
    expect(dsoMagnitudeLimitForFov(90)).toBe(7);
    expect(dsoMagnitudeLimitForFov(120)).toBe(7);
    expect(dsoMagnitudeLimitForFov(1)).toBe(14);
    expect(dsoMagnitudeLimitForFov(0.5)).toBe(14);
    expect(dsoMagnitudeLimitForFov(Math.sqrt(90))).toBeCloseTo(10.5, 12);
  });

  it('dsoMagnitudeLimit follows the field or the manual override plus one', () => {
    expect(DSO_MANUAL_LIMIT_OFFSET).toBe(1);
    expect(dsoMagnitudeLimit(60, null)).toBe(dsoMagnitudeLimitForFov(60));
    expect(dsoMagnitudeLimit(60, 5.5)).toBe(6.5);
    expect(dsoMagnitudeLimit(1, 2)).toBe(3);
  });
});

describe('dsoSizeLimitArcmin and dsoVisible', () => {
  it('scales with the field: 12 arcmin at 60 degrees, 0.2 at 1 degree', () => {
    expect(DSO_SIZE_LIMIT_FRACTION).toBe(1 / 300);
    expect(dsoSizeLimitArcmin(60)).toBeCloseTo(12, 12);
    expect(dsoSizeLimitArcmin(1)).toBeCloseTo(0.2, 12);
  });

  it('shows an object bright enough OR large enough, and hides unknown values', () => {
    // mag only, size only, both, neither.
    expect(dsoVisible(5, 1, 7, 12)).toBe(true);
    expect(dsoVisible(9, 30, 7, 12)).toBe(true);
    expect(dsoVisible(5, 30, 7, 12)).toBe(true);
    expect(dsoVisible(9, 1, 7, 12)).toBe(false);
    // Boundaries are inclusive.
    expect(dsoVisible(7, 0, 7, 12)).toBe(true);
    expect(dsoVisible(9, 12, 7, 12)).toBe(true);
    // The sentinels of unknown values never pass their own test.
    expect(DSO_MAG_UNKNOWN).toBe(99);
    expect(dsoVisible(DSO_MAG_UNKNOWN, 0, 14, 0.2)).toBe(false);
    expect(dsoVisible(DSO_MAG_UNKNOWN, 30, 7, 12)).toBe(true);
  });
});

describe('dsoPixelRadius', () => {
  it('is the true semi-axis on screen or the minimum, whichever is larger', () => {
    expect(DSO_MIN_RADIUS_PX).toBe(4);
    expect(DSO_LINE_WIDTH_PX).toBe(1.2);
    const fov = 60 * DEG;
    // A 1 arcmin object is far below the 4 px floor at a 60 degree field.
    expect(dsoPixelRadius((0.5 / 60) * DEG, fov, 1000, 4)).toBe(4);
    // A 3 degree semi-axis in a 60 degree field on 1000 px: tan(3)/tan(30) * 500.
    const expected = (Math.tan(3 * DEG) / Math.tan(30 * DEG)) * 500;
    expect(dsoPixelRadius(3 * DEG, fov, 1000, 4)).toBeCloseTo(expected, 9);
    expect(expected).toBeGreaterThan(4);
  });
});

describe('northTangent and screenPositionAngle', () => {
  it('points to the pole along the meridian and is undefined at the poles', () => {
    const out = vec3();
    expect(northTangent(out, [1, 0, 0])).toBe(true);
    expect(out[0]).toBeCloseTo(0, 12);
    expect(out[1]).toBeCloseTo(0, 12);
    expect(out[2]).toBeCloseTo(1, 12);
    const d: Vec3 = [Math.cos(45 * DEG), 0, Math.sin(45 * DEG)];
    expect(northTangent(out, d)).toBe(true);
    expect(length3(out)).toBeCloseTo(1, 12);
    expect(out[0] * d[0] + out[2] * d[2]).toBeCloseTo(0, 12);
    expect(out[2]).toBeGreaterThan(0);
    // Southern object: north still has a positive Z component toward the pole.
    expect(northTangent(out, [0, Math.cos(-30 * DEG), Math.sin(-30 * DEG)])).toBe(true);
    expect(out[2]).toBeGreaterThan(0);
    const untouched: Vec3 = [7, 8, 9];
    expect(northTangent(untouched, [0, 0, 1])).toBe(false);
    expect(northTangent(untouched, [0, 0, -1])).toBe(false);
    expect(untouched).toEqual([7, 8, 9]);
  });

  it('puts north up and leans a positive position angle toward the east (left on screen)', () => {
    // Identity horizon rotation: the ICRF pole is the zenith, the object sits on the east
    // horizon (RA 0, Dec 0 -> ENU (1, 0, 0)) and the camera looks east (az 90).
    const dir: Vec3 = [1, 0, 0];
    const north = vec3();
    expect(northTangent(north, dir)).toBe(true);
    const cameraRight: Vec3 = [Math.cos(90 * DEG), -Math.sin(90 * DEG), 0];
    const right = vec3();
    const up = vec3();
    billboardBasis(right, up, dir, cameraRight);
    expect(screenPositionAngle(north, right, up, 0)).toBeCloseTo(Math.PI / 2, 12);
    expect(screenPositionAngle(north, right, up, Math.PI / 4)).toBeCloseTo((3 * Math.PI) / 4, 12);
    // The same object seen with the camera looking north: it lies on the camera's right axis,
    // the degenerate branch of the billboard basis, and north is still up.
    billboardBasis(right, up, dir, [1, 0, 0]);
    expect(screenPositionAngle(north, right, up, 0)).toBeCloseTo(Math.PI / 2, 12);
    // An object on the meridian at 45 degrees, camera looking north at 45 degrees: north is up.
    const d2: Vec3 = [0, Math.cos(45 * DEG), Math.sin(45 * DEG)];
    expect(northTangent(north, d2)).toBe(true);
    billboardBasis(right, up, d2, [1, 0, 0]);
    expect(screenPositionAngle(north, right, up, 0)).toBeCloseTo(Math.PI / 2, 12);
  });
});

describe('symbolIdOf and writeDsoShape', () => {
  it('numbers the six contract types in order and draws anything else as other', () => {
    expect(DSO_SYMBOL_TYPES).toEqual(DSO_TYPES);
    DSO_TYPES.forEach((type, i) => {
      expect(symbolIdOf(type)).toBe(i);
    });
    expect(symbolIdOf('quasar')).toBe(5);
  });

  it('packs (mag or 99, major semi-axis rad, ratio or 1, pa rad or 0)', () => {
    const out = new Float32Array(8);
    writeDsoShape(out, 0, 3.44, 177.83, 69.66, 35);
    expect(out[0]).toBeCloseTo(3.44, 5);
    expect(out[1]).toBeCloseTo((177.83 / 2 / 60) * DEG, 8);
    expect(out[2]).toBeCloseTo(69.66 / 177.83, 6);
    expect(out[3]).toBeCloseTo(35 * DEG, 6);
    // Unknown magnitude and position angle, missing minor axis.
    writeDsoShape(out, 4, null, 6, null, undefined);
    expect(out[4]).toBe(99);
    expect(out[5]).toBeCloseTo((6 / 2 / 60) * DEG, 8);
    expect(out[6]).toBe(1);
    expect(out[7]).toBe(0);
    // Missing major axis: zero semi-axis and a unit ratio even when a minor axis is given.
    writeDsoShape(out, 0, undefined, undefined, 2, null);
    expect(out[0]).toBe(99);
    expect(out[1]).toBe(0);
    expect(out[2]).toBe(1);
    writeDsoShape(out, 0, 8, null, undefined, 10);
    expect(out[2]).toBe(1);
    expect(out[3]).toBeCloseTo(10 * DEG, 6);
  });
});

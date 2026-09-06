// @vitest-environment node
// Star appearance rules (SKY-1, plan D82): the field-of-view magnitude limit, monotonic pixel
// sizes within their clamp, Pogson brightness and the documented B-V colour stops.

import {
  BV_COLOR_STOPS,
  NARROW_FIELD_FOV_DEG,
  STAR_REFERENCE_MAG,
  STAR_SIZE_BASE_PX,
  STAR_SIZE_MAX_PX,
  STAR_SIZE_MIN_PX,
  STAR_SIZE_PER_MAG,
  STAR_SIZE_ZOOM_MAG,
  WIDE_FIELD_FOV_DEG,
  WIDE_FIELD_MAG_LIMIT,
  bvToRgb,
  magnitudeLimitForFov,
  starBrightness,
  starPixelRadius,
} from './stars';
import { vec3 } from './typed';

const CATALOG_LIMIT = 12.5;

describe('magnitudeLimitForFov', () => {
  it('is 6.5 at 90 degrees and wider (SKY-1)', () => {
    expect(WIDE_FIELD_MAG_LIMIT).toBe(6.5);
    expect(WIDE_FIELD_FOV_DEG).toBe(90);
    expect(NARROW_FIELD_FOV_DEG).toBe(1);
    expect(magnitudeLimitForFov(90, CATALOG_LIMIT)).toBe(6.5);
    expect(magnitudeLimitForFov(120, CATALOG_LIMIT)).toBe(6.5);
  });

  it('reaches the catalog limit at 1 degree and narrower', () => {
    expect(magnitudeLimitForFov(1, CATALOG_LIMIT)).toBe(CATALOG_LIMIT);
    expect(magnitudeLimitForFov(0.5, CATALOG_LIMIT)).toBe(CATALOG_LIMIT);
  });

  it('rises on a log scale in between and never decreases when zooming in', () => {
    expect(magnitudeLimitForFov(Math.sqrt(90), CATALOG_LIMIT)).toBeCloseTo(9.5, 12);
    let previous = magnitudeLimitForFov(90, CATALOG_LIMIT);
    for (let fov = 89; fov >= 1; fov -= 1) {
      const limit = magnitudeLimitForFov(fov, CATALOG_LIMIT);
      expect(limit).toBeGreaterThanOrEqual(previous);
      previous = limit;
    }
  });
});

describe('starPixelRadius', () => {
  it('exports the constants the shader mirrors', () => {
    expect(STAR_SIZE_BASE_PX).toBe(1);
    expect(STAR_SIZE_PER_MAG).toBe(0.55);
    expect(STAR_SIZE_MIN_PX).toBe(1);
    expect(STAR_SIZE_MAX_PX).toBe(12);
    expect(STAR_REFERENCE_MAG).toBe(6.5);
    expect(STAR_SIZE_ZOOM_MAG).toBe(3);
  });

  it('draws the reference magnitude at the base size in a 90 degree field', () => {
    expect(starPixelRadius(STAR_REFERENCE_MAG, 90)).toBe(STAR_SIZE_BASE_PX);
    expect(starPixelRadius(0, 90)).toBeCloseTo(1 + 0.55 * 6.5, 12);
  });

  it('is monotonic in -mag and clamped to [1, 12] CSS pixels', () => {
    for (const fov of [120, 90, 30, 5, 1, 0.5]) {
      let previous = Infinity;
      for (let mag = -30; mag <= 30; mag += 0.25) {
        const r = starPixelRadius(mag, fov);
        expect(r).toBeLessThanOrEqual(previous);
        expect(r).toBeGreaterThanOrEqual(STAR_SIZE_MIN_PX);
        expect(r).toBeLessThanOrEqual(STAR_SIZE_MAX_PX);
        previous = r;
      }
      expect(starPixelRadius(-30, fov)).toBe(STAR_SIZE_MAX_PX);
      expect(starPixelRadius(30, fov)).toBe(STAR_SIZE_MIN_PX);
    }
  });

  it('grows a star when zooming in: the reference magnitude shifts by 3 at 1 degree', () => {
    expect(starPixelRadius(6.5, 1)).toBeCloseTo(1 + 0.55 * 3, 12);
    expect(starPixelRadius(9.5, 1)).toBeCloseTo(1, 12);
    expect(starPixelRadius(3, 10)).toBeGreaterThan(starPixelRadius(3, 90));
  });
});

describe('starBrightness', () => {
  it('follows Pogson ratio clamped to [0, 1]', () => {
    expect(starBrightness(6.5, 6.5)).toBe(1);
    expect(starBrightness(9, 6.5)).toBeCloseTo(0.1, 12);
    expect(starBrightness(5, 0)).toBeCloseTo(0.01, 12);
    expect(starBrightness(-1.5, 6.5)).toBe(1);
    expect(starBrightness(60, 6.5)).toBeGreaterThanOrEqual(0);
    expect(starBrightness(60, 6.5)).toBeLessThan(1e-20);
  });
});

describe('bvToRgb', () => {
  it('documents the piecewise-linear stops', () => {
    expect(BV_COLOR_STOPS.map((s) => s[0])).toEqual([-0.33, 0.0, 0.3, 0.6, 1.0, 1.4]);
    expect(BV_COLOR_STOPS.map((s) => [s[1], s[2], s[3]].map((c) => Math.round(c * 255)))).toEqual([
      [155, 176, 255],
      [202, 216, 255],
      [248, 247, 255],
      [255, 244, 234],
      [255, 210, 161],
      [255, 204, 111],
    ]);
  });

  it('reproduces each stop exactly and returns out', () => {
    for (const stop of BV_COLOR_STOPS) {
      const out = vec3();
      expect(bvToRgb(out, stop[0])).toBe(out);
      expect(out).toEqual([stop[1], stop[2], stop[3]]);
    }
  });

  it('interpolates linearly between stops', () => {
    // Halfway between 0.0 (202,216,255) and 0.3 (248,247,255).
    const mid = bvToRgb(vec3(), 0.15);
    expect(mid[0] * 255).toBeCloseTo(225, 10);
    expect(mid[1] * 255).toBeCloseTo(231.5, 10);
    expect(mid[2] * 255).toBeCloseTo(255, 10);
    // A quarter of the way from 1.0 to 1.4.
    const warm = bvToRgb(vec3(), 1.1);
    expect(warm[0] * 255).toBeCloseTo(255, 10);
    expect(warm[1] * 255).toBeCloseTo(208.5, 10);
    expect(warm[2] * 255).toBeCloseTo(148.5, 10);
  });

  it('clamps to the end stops outside [-0.33, 1.4], including the 0.65 unknown default', () => {
    expect(bvToRgb(vec3(), -2)).toEqual([155 / 255, 176 / 255, 1]);
    expect(bvToRgb(vec3(), 5)).toEqual([1, 204 / 255, 111 / 255]);
    const unknown = bvToRgb(vec3(), 0.65);
    expect(unknown[0]).toBe(1);
    expect(unknown[1]).toBeLessThan(244 / 255);
    expect(unknown[1]).toBeGreaterThan(210 / 255);
  });
});

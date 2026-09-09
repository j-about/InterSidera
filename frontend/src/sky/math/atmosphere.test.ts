// @vitest-environment node
// Sky brightness and twilight (SKY-7, plan D104): continuity at every twilight seam, the tint
// peak, the colour model, the ground modes and the star fade the shaders apply.

import {
  ASTRONOMICAL_TWILIGHT_DEG,
  CIVIL_END_BRIGHTNESS,
  CIVIL_TWILIGHT_DEG,
  GROUND_ALPHA_DIM,
  GROUND_ALPHA_OPAQUE,
  GROUND_COLOR,
  HORIZON_DAY,
  NAUTICAL_END_BRIGHTNESS,
  NAUTICAL_TWILIGHT_DEG,
  SKY_BLACK_BELOW_DEG,
  STAR_FADE_BRIGHTNESS,
  STAR_FADE_MAGNITUDES,
  TWILIGHT_PEAK_DEG,
  TWILIGHT_TINT,
  TWILIGHT_TINT_STRENGTH,
  ZENITH_DAY,
  effectiveMagLimit,
  groundAlpha,
  groundColor,
  skyBrightness,
  skyColor,
  starFadeMagnitudes,
  twilight,
  wrapDeltaDeg,
} from './atmosphere';
import { vec3 } from './typed';

describe('skyBrightness', () => {
  it('is 1 with the Sun up and 0 after astronomical twilight', () => {
    expect(skyBrightness(0)).toBe(1);
    expect(skyBrightness(30)).toBe(1);
    expect(skyBrightness(-18)).toBe(0);
    expect(skyBrightness(-40)).toBe(0);
  });

  it('is continuous at -18, -12, -6 and 0 degrees with the documented seam values', () => {
    expect(CIVIL_TWILIGHT_DEG).toBe(-6);
    expect(NAUTICAL_TWILIGHT_DEG).toBe(-12);
    expect(ASTRONOMICAL_TWILIGHT_DEG).toBe(-18);
    const eps = 1e-9;
    for (const [seam, value] of [
      [0, 1],
      [-6, CIVIL_END_BRIGHTNESS],
      [-12, NAUTICAL_END_BRIGHTNESS],
      [-18, 0],
    ] as const) {
      expect(skyBrightness(seam)).toBeCloseTo(value, 12);
      expect(skyBrightness(seam - eps)).toBeCloseTo(value, 6);
      expect(skyBrightness(seam + eps)).toBeCloseTo(value, 6);
    }
    // Linear inside each band: the midpoints.
    expect(skyBrightness(-3)).toBeCloseTo((CIVIL_END_BRIGHTNESS + 1) / 2, 12);
    expect(skyBrightness(-9)).toBeCloseTo((NAUTICAL_END_BRIGHTNESS + CIVIL_END_BRIGHTNESS) / 2, 12);
    expect(skyBrightness(-15)).toBeCloseTo(NAUTICAL_END_BRIGHTNESS / 2, 12);
  });

  it('never increases as the Sun sets', () => {
    let previous = 1;
    for (let s = 5; s >= -25; s -= 0.25) {
      const b = skyBrightness(s);
      expect(b).toBeLessThanOrEqual(previous);
      expect(b).toBeGreaterThanOrEqual(0);
      previous = b;
    }
  });
});

describe('twilight', () => {
  it('peaks at -3 degrees and falls off symmetrically over 5 degrees', () => {
    expect(TWILIGHT_PEAK_DEG).toBe(-3);
    expect(twilight(-3)).toBe(1);
    expect(twilight(2)).toBeCloseTo(Math.exp(-1), 12);
    expect(twilight(-8)).toBeCloseTo(Math.exp(-1), 12);
    expect(twilight(-3 + 10)).toBeCloseTo(twilight(-3 - 10), 12);
    expect(twilight(40)).toBeLessThan(1e-20);
  });
});

describe('wrapDeltaDeg', () => {
  it('wraps into [-180, 180)', () => {
    expect(wrapDeltaDeg(0)).toBe(0);
    expect(wrapDeltaDeg(190)).toBe(-170);
    expect(wrapDeltaDeg(-190)).toBe(170);
    expect(wrapDeltaDeg(180)).toBe(-180);
    expect(wrapDeltaDeg(-180)).toBe(-180);
    expect(wrapDeltaDeg(720 + 30)).toBe(30);
  });
});

describe('skyColor', () => {
  it('is black below -3 degrees whatever the Sun does', () => {
    expect(SKY_BLACK_BELOW_DEG).toBe(-3);
    expect(skyColor(vec3(), -3.01, 0, 20)).toEqual([0, 0, 0]);
    expect(skyColor(vec3(), -45, 0, -3)).toEqual([0, 0, 0]);
  });

  it('paints the daylight gradient with the Sun high: zenith blue, horizon pale', () => {
    const zenith = skyColor(vec3(), 90, 120, 40);
    expect(zenith[0]).toBeCloseTo(ZENITH_DAY[0], 9);
    expect(zenith[1]).toBeCloseTo(ZENITH_DAY[1], 9);
    expect(zenith[2]).toBeCloseTo(ZENITH_DAY[2], 9);
    const horizon = skyColor(vec3(), 0, 120, 40);
    expect(horizon[0]).toBeCloseTo(HORIZON_DAY[0], 9);
    expect(horizon[2]).toBeCloseTo(HORIZON_DAY[2], 9);
    // Blue dominates red everywhere by day, and the gradient darkens with altitude.
    const mid = skyColor(vec3(), 30, 120, 40);
    expect(mid[2]).toBeGreaterThan(mid[0]);
    expect(mid[2]).toBeLessThan(horizon[2]);
    expect(mid[2]).toBeGreaterThan(zenith[2]);
  });

  it('adds the orange tint toward the Sun at civil twilight and none opposite or high up', () => {
    const towardSun = skyColor(vec3(), 0, 0, -3);
    const opposite = skyColor(vec3(), 0, 180, -3);
    // Toward the Sun the full tint applies over the residual gradient.
    const residual = HORIZON_DAY[0] * skyBrightness(-3);
    expect(towardSun[0]).toBeCloseTo(residual + TWILIGHT_TINT[0] * TWILIGHT_TINT_STRENGTH, 9);
    expect(towardSun[0]).toBeGreaterThan(towardSun[2]);
    // 180 degrees away the tint is exp(-9): negligible.
    expect(opposite[0]).toBeCloseTo(residual, 3);
    expect(opposite[0]).toBeLessThan(opposite[2]);
    // The tint decays with altitude: at 36 degrees it is exp(-3) of the horizon value.
    const high = skyColor(vec3(), 36, 0, -3);
    const tintHigh = high[0] - HORIZON_DAY[0] * skyBrightness(-3) * 0 - mixExpectation(36);
    expect(tintHigh).toBeCloseTo(TWILIGHT_TINT[0] * TWILIGHT_TINT_STRENGTH * Math.exp(-3), 9);
    // Below the horizon (down to -3) the altitude decay is clamped at 0.
    const low = skyColor(vec3(), -2, 0, -3);
    expect(low[0]).toBeCloseTo(towardSun[0], 9);
  });

  /** The red channel of the daylight gradient alone at civil twilight peak. */
  function mixExpectation(altDeg: number): number {
    const t = Math.pow(altDeg / 90, 0.6);
    return (HORIZON_DAY[0] + (ZENITH_DAY[0] - HORIZON_DAY[0]) * t) * skyBrightness(-3);
  }

  it('is black at night without the Sun anywhere near the horizon', () => {
    const night = skyColor(vec3(), 45, 0, -30);
    expect(night[0]).toBeLessThan(1e-9);
    expect(night[1]).toBeLessThan(1e-9);
    expect(night[2]).toBeLessThan(1e-9);
  });
});

describe('ground and star fade', () => {
  it('reports the ground colour and the opacity of each SKY-6 mode', () => {
    expect(groundColor(vec3())).toEqual([GROUND_COLOR[0], GROUND_COLOR[1], GROUND_COLOR[2]]);
    expect(groundAlpha('opaque')).toBe(GROUND_ALPHA_OPAQUE);
    expect(groundAlpha('opaque')).toBe(1);
    expect(groundAlpha('dim')).toBe(GROUND_ALPHA_DIM);
    expect(groundAlpha('dim')).toBe(0.6);
    expect(groundAlpha('off')).toBe(0);
  });

  it('fades the magnitude limit by 8 B and documents the brightness loss', () => {
    expect(STAR_FADE_MAGNITUDES).toBe(8);
    expect(STAR_FADE_BRIGHTNESS).toBe(0.85);
    expect(starFadeMagnitudes(1)).toBe(8);
    expect(starFadeMagnitudes(0)).toBe(0);
    expect(effectiveMagLimit(6.5, 1)).toBeCloseTo(-1.5, 12);
    expect(effectiveMagLimit(6.5, 0.3)).toBeCloseTo(4.1, 12);
    expect(effectiveMagLimit(6.5, 0)).toBe(6.5);
  });
});

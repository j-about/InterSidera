// Daylight and twilight of the sky background (SKY-7, brief l.215, plan D104). Pure,
// dependency-free, allocation-free. The only astronomical input is the Sun altitude the engine
// derives from the backend `sun_dir` rotated by the horizon quaternion (brief l.41): everything
// here is a visual model, mirrored line by line by the background shaders (`skyBrightness`,
// `twilight`, `skyColor`) and read by the star and DSO shaders through the `uAtmosphere` uniform
// (`effectiveMagLimit`, `STAR_FADE_BRIGHTNESS`).

import type { Vec3 } from './typed';

/** Civil, nautical and astronomical twilight ends (Sun altitude, degrees). */
export const CIVIL_TWILIGHT_DEG = -6;
export const NAUTICAL_TWILIGHT_DEG = -12;
export const ASTRONOMICAL_TWILIGHT_DEG = -18;
/** Sky brightness at the end of civil twilight ... */
export const CIVIL_END_BRIGHTNESS = 0.3;
/** ... and at the end of nautical twilight (1 at sunset, 0 at the end of astronomical twilight). */
export const NAUTICAL_END_BRIGHTNESS = 0.05;
/** The twilight tint peaks when the Sun stands here and fades over 5 degrees either side. */
export const TWILIGHT_PEAK_DEG = -3;
export const TWILIGHT_WIDTH_DEG = 5;
/** Below this altitude a sky pixel is black (the ground pass paints what lies there). */
export const SKY_BLACK_BELOW_DEG = -3;
/** The daytime gradient, horizon to zenith, sRGB 0..1. */
export const HORIZON_DAY: readonly [number, number, number] = [0.62, 0.76, 0.92];
export const ZENITH_DAY: readonly [number, number, number] = [0.16, 0.36, 0.78];
/** The twilight tint added toward the Sun's azimuth. */
export const TWILIGHT_TINT: readonly [number, number, number] = [1.0, 0.5, 0.2];
export const TWILIGHT_TINT_STRENGTH = 0.8;
/** The tint decays over this altitude (degrees) above the horizon ... */
export const TWILIGHT_ALT_SCALE_DEG = 12;
/** ... and over this azimuth distance (degrees) from the Sun. */
export const TWILIGHT_AZ_SCALE_DEG = 60;
/** The daylight gradient follows `clamp(alt / 90)^GRADIENT_POWER`. */
export const GRADIENT_POWER = 0.6;
/** Stars fade by this many magnitudes at full daylight (`limit - 8 B`) ... */
export const STAR_FADE_MAGNITUDES = 8;
/** ... and lose this fraction of their brightness (`brightness *= 1 - 0.85 B`). */
export const STAR_FADE_BRIGHTNESS = 0.85;
/** The ground colour (mode 1 of the background shader), sRGB 0..1. */
export const GROUND_COLOR: readonly [number, number, number] = [0.09, 0.08, 0.07];
/** Ground opacity per SKY-6 mode; `off` hides the pass. */
export const GROUND_ALPHA_OPAQUE = 1;
export const GROUND_ALPHA_DIM = 0.6;

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Sky brightness in `[0, 1]` for a Sun altitude in degrees: 1 with the Sun up, linear ramps to
 * 0.30 at the end of civil twilight, 0.05 at the end of nautical twilight and 0 at the end of
 * astronomical twilight, 0 below. Continuous at every seam.
 */
export function skyBrightness(sunAltDeg: number): number {
  if (sunAltDeg >= 0) {
    return 1;
  }
  if (sunAltDeg >= CIVIL_TWILIGHT_DEG) {
    return mix(CIVIL_END_BRIGHTNESS, 1, (sunAltDeg - CIVIL_TWILIGHT_DEG) / -CIVIL_TWILIGHT_DEG);
  }
  if (sunAltDeg >= NAUTICAL_TWILIGHT_DEG) {
    return mix(
      NAUTICAL_END_BRIGHTNESS,
      CIVIL_END_BRIGHTNESS,
      (sunAltDeg - NAUTICAL_TWILIGHT_DEG) / (CIVIL_TWILIGHT_DEG - NAUTICAL_TWILIGHT_DEG),
    );
  }
  if (sunAltDeg >= ASTRONOMICAL_TWILIGHT_DEG) {
    return mix(
      0,
      NAUTICAL_END_BRIGHTNESS,
      (sunAltDeg - ASTRONOMICAL_TWILIGHT_DEG) / (NAUTICAL_TWILIGHT_DEG - ASTRONOMICAL_TWILIGHT_DEG),
    );
  }
  return 0;
}

/** Twilight tint weight `exp(-((s + 3) / 5)^2)`: 1 with the Sun 3 degrees below the horizon. */
export function twilight(sunAltDeg: number): number {
  const u = (sunAltDeg - TWILIGHT_PEAK_DEG) / TWILIGHT_WIDTH_DEG;
  return Math.exp(-u * u);
}

/** Signed azimuth difference wrapped into `[-180, 180)`. */
export function wrapDeltaDeg(deltaDeg: number): number {
  return deltaDeg - 360 * Math.floor((deltaDeg + 180) / 360);
}

/**
 * Colour of a sky pixel at altitude `altDeg`, `dAzDeg` of azimuth away from the Sun, for a Sun
 * altitude `sunAltDeg`: the daylight gradient scaled by the brightness plus the twilight tint,
 * strongest low toward the Sun; black below -3 degrees.
 */
export function skyColor(out: Vec3, altDeg: number, dAzDeg: number, sunAltDeg: number): Vec3 {
  if (altDeg < SKY_BLACK_BELOW_DEG) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    return out;
  }
  const brightness = skyBrightness(sunAltDeg);
  const t = Math.pow(Math.max(0, Math.min(1, altDeg / 90)), GRADIENT_POWER);
  const dAz = wrapDeltaDeg(dAzDeg) / TWILIGHT_AZ_SCALE_DEG;
  const tint =
    twilight(sunAltDeg) *
    Math.exp(-Math.max(altDeg, 0) / TWILIGHT_ALT_SCALE_DEG) *
    Math.exp(-dAz * dAz) *
    TWILIGHT_TINT_STRENGTH;
  out[0] = mix(HORIZON_DAY[0], ZENITH_DAY[0], t) * brightness + TWILIGHT_TINT[0] * tint;
  out[1] = mix(HORIZON_DAY[1], ZENITH_DAY[1], t) * brightness + TWILIGHT_TINT[1] * tint;
  out[2] = mix(HORIZON_DAY[2], ZENITH_DAY[2], t) * brightness + TWILIGHT_TINT[2] * tint;
  return out;
}

/** The ground colour into `out`. */
export function groundColor(out: Vec3): Vec3 {
  out[0] = GROUND_COLOR[0];
  out[1] = GROUND_COLOR[1];
  out[2] = GROUND_COLOR[2];
  return out;
}

/** Ground opacity of a SKY-6 mode: opaque 1, dim 0.6, off 0 (the pass is hidden). */
export function groundAlpha(ground: 'opaque' | 'dim' | 'off'): number {
  switch (ground) {
    case 'opaque':
      return GROUND_ALPHA_OPAQUE;
    case 'dim':
      return GROUND_ALPHA_DIM;
    case 'off':
      return 0;
  }
}

/** Magnitudes lost to the sky brightness: `8 B`. */
export function starFadeMagnitudes(brightness: number): number {
  return STAR_FADE_MAGNITUDES * brightness;
}

/** The magnitude limit the star and DSO shaders apply under a sky of brightness `B`: `limit - 8 B`. */
export function effectiveMagLimit(magLimit: number, brightness: number): number {
  return magLimit - starFadeMagnitudes(brightness);
}

// Coordinate entry (OBS-3, brief l.192; plan D96): pure parsers for the latitude, longitude and
// elevation fields of the observer panel, and the preview of what the sky service will receive
// (OBS-7: the store keeps the typed value, `api/client.ts::observerQuery` and the URL codec round
// to 0.01 degrees; this module reproduces that rounding through `url.ts` alone, never through the
// fetch layer). Decimal degrees or degrees-minutes-seconds with the usual symbols, spaces or
// colons, a hemisphere letter before or after (`N S` / `E W O`, the French Ouest), a comma as
// decimal separator when no dot is present, and the typographic minus U+2212.

import type { Observer } from './types';
import { roundUrlValue, wrapLongitudeDeg } from './url';

export type CoordError = 'empty' | 'syntax' | 'range' | 'hemisphere';

export type CoordParse = { ok: true; deg: number } | { ok: false; error: CoordError };

export type ElevationError = 'empty' | 'syntax' | 'range';

export type ElevationParse = { ok: true; metres: number } | { ok: false; error: ElevationError };

/** URL bounds of `elev` (metres), the same as `url.ts::parseUrlState`. */
export const ELEVATION_MIN_M = -12000;
export const ELEVATION_MAX_M = 100000;

const LAT_LETTERS = new Set(['N', 'S']);
const LON_LETTERS = new Set(['E', 'W', 'O']);
const SOUTH_OR_WEST = new Set(['S', 'W', 'O']);
/**
 * Degree, minute and second markers, and the colon form (`48:51:24`); every one is a separator.
 * The letter markers `m` and `s` of `48d51m24s` are deliberately not accepted: `s` is also the
 * southern hemisphere and `48d51m24s` would read as 48d51m24 South; the hint lists the accepted
 * forms.
 */
const MARKERS_RE = /[°º˚dD:'′’"″”]/g;
const COMPONENT_RE = /^\d+(\.\d+)?$/;
const INTEGER_RE = /^\d+$/;

interface Hemisphere {
  /** `-1` for S, W and O, `+1` otherwise; `null` when no letter was written. */
  sign: number | null;
  /** The text without the letter. */
  rest: string;
  /** A letter of the other axis. */
  wrongAxis: boolean;
}

/** Normalise the typographic minus and a lone comma used as decimal separator. */
function normalise(text: string): string {
  let out = text.trim().replace(/−/g, '-');
  if (!out.includes('.') && out.split(',').length === 2) {
    out = out.replace(',', '.');
  }
  return out;
}

function stripHemisphere(text: string, letters: ReadonlySet<string>): Hemisphere {
  const first = text.charAt(0).toUpperCase();
  const last = text.charAt(text.length - 1).toUpperCase();
  const all = new Set([...LAT_LETTERS, ...LON_LETTERS]);
  const firstIsLetter = all.has(first);
  const lastIsLetter = text.length > 1 && all.has(last);
  if (firstIsLetter && lastIsLetter) {
    // Two letters can never be right: reported as a hemisphere error.
    return { sign: null, rest: text, wrongAxis: true };
  }
  if (firstIsLetter) {
    return {
      sign: SOUTH_OR_WEST.has(first) ? -1 : 1,
      rest: text.slice(1).trim(),
      wrongAxis: !letters.has(first),
    };
  }
  if (lastIsLetter) {
    return {
      sign: SOUTH_OR_WEST.has(last) ? -1 : 1,
      rest: text.slice(0, -1).trim(),
      wrongAxis: !letters.has(last),
    };
  }
  return { sign: null, rest: text, wrongAxis: false };
}

/**
 * Unsigned degrees of `text` (decimal or up to three DMS components, only the last fractional,
 * minutes and seconds below 60), `null` when the text is not a coordinate.
 */
function parseUnsignedDegrees(text: string): number | null {
  const parts = text.replace(MARKERS_RE, ' ').trim().split(/\s+/);
  if (parts.length > 3) {
    return null;
  }
  let total = 0;
  let scale = 1;
  for (const [index, part] of parts.entries()) {
    const isLast = index === parts.length - 1;
    if (!(isLast ? COMPONENT_RE : INTEGER_RE).test(part)) {
      return null;
    }
    const value = Number(part);
    if (index > 0 && value >= 60) {
      return null;
    }
    total += value * scale;
    scale /= 60;
  }
  return total;
}

function parseSigned(text: string, letters: ReadonlySet<string>): CoordParse {
  const normalised = normalise(text);
  if (normalised === '') {
    return { ok: false, error: 'empty' };
  }
  const hemisphere = stripHemisphere(normalised, letters);
  if (hemisphere.wrongAxis) {
    return { ok: false, error: 'hemisphere' };
  }
  let body = hemisphere.rest;
  let sign = 1;
  if (body.startsWith('-') || body.startsWith('+')) {
    if (hemisphere.sign !== null) {
      // `-73.98 W`: a sign and a letter contradict (or repeat) each other.
      return { ok: false, error: 'hemisphere' };
    }
    sign = body.startsWith('-') ? -1 : 1;
    body = body.slice(1).trim();
  }
  const magnitude = parseUnsignedDegrees(body);
  if (magnitude === null) {
    return { ok: false, error: 'syntax' };
  }
  const value = magnitude * (hemisphere.sign ?? sign);
  return { ok: true, deg: value === 0 ? 0 : value };
}

/** A latitude in `[-90, 90]` degrees. */
export function parseLatitude(text: string): CoordParse {
  const parsed = parseSigned(text, LAT_LETTERS);
  if (!parsed.ok) {
    return parsed;
  }
  if (Math.abs(parsed.deg) > 90) {
    return { ok: false, error: 'range' };
  }
  return parsed;
}

/** An east longitude, accepted up to 360 degrees either way and wrapped into `[-180, 180)`. */
export function parseLongitude(text: string): CoordParse {
  const parsed = parseSigned(text, LON_LETTERS);
  if (!parsed.ok) {
    return parsed;
  }
  if (Math.abs(parsed.deg) > 360) {
    return { ok: false, error: 'range' };
  }
  return { ok: true, deg: wrapLongitudeDeg(parsed.deg) };
}

/** An elevation in metres within the URL bounds; a trailing `m` is accepted. */
export function parseElevation(text: string): ElevationParse {
  const normalised = normalise(text).replace(/\s*m$/i, '');
  if (normalised === '') {
    return { ok: false, error: 'empty' };
  }
  if (!/^[-+]?\d+(\.\d+)?$/.test(normalised)) {
    return { ok: false, error: 'syntax' };
  }
  const metres = Number(normalised);
  if (metres < ELEVATION_MIN_M || metres > ELEVATION_MAX_M) {
    return { ok: false, error: 'range' };
  }
  return { ok: true, metres: metres === 0 ? 0 : metres };
}

/** Decimal degrees with at most `decimals` fractional digits, trailing zeros dropped, no `-0`. */
export function formatDegrees(deg: number, decimals = 4): string {
  const rounded = Number(deg.toFixed(decimals));
  return String(rounded === 0 ? 0 : rounded);
}

/** Metres as an integer string (the URL precision of `elev`). */
export function formatElevation(metres: number): string {
  return String(roundUrlValue('elev', metres));
}

/**
 * The observer as the sky service and the URL receive it (OBS-7): latitude and longitude to
 * 0.01 degrees, the longitude wrapped, the elevation to the metre. Mirrors
 * `api/client.ts::observerQuery` without importing the fetch layer (a test asserts they agree).
 */
export function roundedObserverPreview(observer: Observer): {
  lat: number;
  lon: number;
  elev: number;
} {
  return {
    lat: roundUrlValue('lat', observer.lat),
    lon: wrapLongitudeDeg(roundUrlValue('lon', observer.lon)),
    elev: roundUrlValue('elev', observer.elev),
  };
}

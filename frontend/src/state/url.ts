// URL codec of the shareable view state (UX-2, brief l.246; OBS-8, l.197; plan D79). Pure and
// dependency-free: the impure half (`history.replaceState`, `popstate`) lives in `urlSync.ts`.
//
// Parsing is defensive (brief l.552): an unknown or invalid parameter is simply absent from the
// result and the store keeps its default, so a hand-edited URL never breaks the page. Numbers are
// rounded on the way out (coordinates and alt/az 0.01 deg, fov 0.1 deg, tt 1e-6 day) to keep
// URLs short, and default-valued keys are omitted except the observer, `t`, the view and `lang`,
// which are always written so a copied link is self-describing (plan Q32).
//
// Out-of-range numbers are dropped, not clamped: `lat`, `alt`, `fov`, `maglim` and `elev` at
// their physical or contract bounds, `t` within the widest ephemeris span (`TT_MIN`..`TT_MAX`)
// and `speed` within `SPEED_MAX`, so no finite URL value can push the clock arithmetic of
// `state/clock.ts` (`ttAnchor + speed * elapsed`) to Infinity.

import { wrapAzimuthDeg } from '../sky/math/frames';
import { DSO_TYPES, LANGS, LAYER_IDS } from './types';
import type { DsoType, Ground, LabelDensity, LayerId, UrlState } from './types';

/** Every UX-2 parameter, in the order they are serialized. */
export const URL_KEYS: readonly (keyof UrlState)[] = [
  'body',
  'lat',
  'lon',
  'elev',
  't',
  'speed',
  'az',
  'alt',
  'fov',
  'layers',
  'ground',
  'atm',
  'refr',
  'maglim',
  'dso',
  'minor',
  'labels',
  'lang',
  'night',
  'sel',
];

/**
 * Keys written even when they hold their default value (plan Q32). `lang` is one of them because
 * a URL without it takes the language of `navigator.languages` (UX-1): like the observer, its
 * default belongs to the browser, so omitting it would not restore the view "from the URL alone"
 * (OBS-8, brief l.197; acceptance l.574) once the user has chosen the other language.
 */
const ALWAYS_WRITTEN: ReadonlySet<keyof UrlState> = new Set<keyof UrlState>([
  'body',
  'lat',
  'lon',
  'elev',
  't',
  'az',
  'alt',
  'fov',
  'lang',
]);

/** Inverse of the rounding step per numeric key (`Math.round(v * inv) / inv` avoids 0.1 * 3 noise). */
const ROUNDING_INVERSE: Readonly<Partial<Record<keyof UrlState, number>>> = {
  lat: 100,
  lon: 100,
  alt: 100,
  az: 100,
  elev: 1,
  fov: 10,
  t: 1e6,
  speed: 10,
  maglim: 10,
  nightLevel: 100,
};

/** Dimmest night-mode brightness (plan D108): `night=0.3`; below it the value is invalid. */
const NIGHT_LEVEL_MIN = 0.3;

/** Maximum number of pinned minor bodies, the `/meta.limits.max_minor_bodies` cap (brief l.164). */
const MAX_MINOR = 100;

/**
 * Bounds of `t` (TT Julian Date): the widest ephemeris, DE441, spans the years -13200..+17191
 * (brief l.51), JD -3.10e6..8.00e6; the margin leaves the exact clamp to `/meta.coverage` (plan
 * D75) while a value no ephemeris could ever cover is treated as invalid (UX-2).
 */
const TT_MIN = -4e6;
const TT_MAX = 1e7;
/**
 * Bound of `speed` (simulated seconds per real second): far above the 31557600 (one year per
 * second) of the brief's list (l.50), yet small enough that `ttAnchor + speed * elapsed` stays
 * finite for any realistic session.
 */
const SPEED_MAX = 1e9;

const NUMBER_RE = /^-?\d+(\.\d+)?$/;
const BODY_RE = /^[a-z]+$/;
const MINOR_ID_RE = /^[ac]:[A-Za-z0-9/_.-]+$/;
// DSO ids are the backend's normalized OpenNGC names (`NGC224`, `IC80_NED01`, `ESO56-115`):
// letters, digits, `_` and `-` (33 of the 5229 ids carry a hyphen), so `-` must be accepted or a
// shared link silently loses its selection (UX-2, brief l.246: "a reload restores everything").
const SEL_RE = /^(hip:\d+|dso:[A-Za-z0-9_-]+|[a-z]+|[ac]:[A-Za-z0-9/_.-]+)$/;
const GROUNDS: readonly Ground[] = ['opaque', 'dim', 'off'];
const LABEL_DENSITIES: readonly LabelDensity[] = [0, 1, 2, 3];

/**
 * Wrap an east longitude into `[-180, 180)` (`180` becomes `-180`, never `-0`). `%` is exact for
 * every finite double and the final +-360 is exact by Sterbenz's lemma, so no rounding can push
 * the result past a bound (a floor-based formula returns -180.00000000000003 for 179.99999999999997).
 */
export function wrapLongitudeDeg(lonDeg: number): number {
  const remainder = lonDeg % 360;
  let wrapped = remainder;
  if (remainder >= 180) {
    wrapped = remainder - 360;
  } else if (remainder < -180) {
    wrapped = remainder + 360;
  }
  return wrapped === 0 ? 0 : wrapped;
}

/** Round a numeric parameter to its URL precision (brief l.552); other keys pass through. */
export function roundUrlValue(key: keyof UrlState, value: number): number {
  const inverse = ROUNDING_INVERSE[key];
  if (inverse === undefined) {
    return value;
  }
  const rounded = Math.round(value * inverse) / inverse;
  // `Math.round(-0.004 * 100) / 100` is `-0`; the URL should never carry a minus sign for zero.
  return rounded === 0 ? 0 : rounded;
}

function parseNumber(text: string | null): number | undefined {
  if (text === null || !NUMBER_RE.test(text)) {
    return undefined;
  }
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

function parseBounded(text: string | null, min: number, max: number): number | undefined {
  const value = parseNumber(text);
  return value !== undefined && value >= min && value <= max ? value : undefined;
}

function parseFlag(text: string | null): boolean | undefined {
  switch (text) {
    case '1':
    case 'true':
      return true;
    case '0':
    case 'false':
      return false;
    default:
      return undefined;
  }
}

/**
 * `night` (plan D108): `0`/`false` off, `1`/`true` on at full brightness, a decimal in
 * `[0.3, 1]` on at that brightness (two decimals; `1.0` and `0.995` are full brightness, the
 * canonical `night=1`); anything else, above 1 included, is absent like any out-of-range value.
 */
function parseNight(text: string | null, out: UrlState): void {
  const flag = parseFlag(text);
  if (flag !== undefined) {
    out.night = flag;
    return;
  }
  const level = parseNumber(text);
  if (level === undefined || level < NIGHT_LEVEL_MIN || level > 1) {
    return;
  }
  // Rounded first: `0.995` is on at full brightness, which `serialize` writes as `night=1`, so
  // the parse must not carry a `nightLevel` of 1 (the round trip would differ from itself).
  const rounded = roundUrlValue('nightLevel', level);
  out.night = true;
  if (rounded < 1) {
    out.nightLevel = rounded;
  }
}

function parseEnum<T extends string>(text: string | null, allowed: readonly T[]): T | undefined {
  return allowed.find((candidate) => candidate === text);
}

/** Split a comma list, keep the known ids, return them deduplicated in canonical order. */
function parseCanonicalList<T extends string>(text: string, allowed: readonly T[]): T[] {
  const present = new Set(text.split(','));
  return allowed.filter((id) => present.has(id));
}

function parseMinor(text: string): string[] {
  const ids: string[] = [];
  for (const item of text.split(',')) {
    if (MINOR_ID_RE.test(item) && !ids.includes(item)) {
      ids.push(item);
      if (ids.length === MAX_MINOR) {
        break;
      }
    }
  }
  return ids;
}

/**
 * Parse a query string (with or without the leading `?`). Never throws: every invalid value is
 * left out (UX-2 "unknown or invalid parameters fall back to defaults without breaking the page").
 */
export function parseUrlState(search: string): UrlState {
  const params = new URLSearchParams(search);
  const out: UrlState = {};

  const body = params.get('body');
  if (body !== null && BODY_RE.test(body)) {
    out.body = body;
  }
  const lat = parseBounded(params.get('lat'), -90, 90);
  if (lat !== undefined) {
    out.lat = lat;
  }
  const lon = parseNumber(params.get('lon'));
  if (lon !== undefined) {
    out.lon = wrapLongitudeDeg(lon);
  }
  const elev = parseBounded(params.get('elev'), -12000, 100000);
  if (elev !== undefined) {
    out.elev = elev;
  }
  const t = params.get('t');
  if (t === 'live') {
    out.t = 'live';
  } else {
    const tt = parseBounded(t, TT_MIN, TT_MAX);
    if (tt !== undefined) {
      out.t = tt;
    }
  }
  const speed = parseBounded(params.get('speed'), -SPEED_MAX, SPEED_MAX);
  if (speed !== undefined) {
    out.speed = speed;
  }
  const az = parseNumber(params.get('az'));
  if (az !== undefined) {
    out.az = wrapAzimuthDeg(az);
  }
  const alt = parseBounded(params.get('alt'), -90, 90);
  if (alt !== undefined) {
    out.alt = alt;
  }
  const fov = parseBounded(params.get('fov'), 1, 120);
  if (fov !== undefined) {
    out.fov = fov;
  }
  const layers = params.get('layers');
  if (layers !== null) {
    out.layers = parseCanonicalList<LayerId>(layers, LAYER_IDS);
  }
  const ground = parseEnum(params.get('ground'), GROUNDS);
  if (ground !== undefined) {
    out.ground = ground;
  }
  const atm = parseFlag(params.get('atm'));
  if (atm !== undefined) {
    out.atm = atm;
  }
  const refr = parseFlag(params.get('refr'));
  if (refr !== undefined) {
    out.refr = refr;
  }
  const maglim = parseBounded(params.get('maglim'), -2, 15);
  if (maglim !== undefined) {
    out.maglim = maglim;
  }
  const dso = params.get('dso');
  if (dso !== null) {
    out.dso = parseCanonicalList<DsoType>(dso, DSO_TYPES);
  }
  const minor = params.get('minor');
  if (minor !== null) {
    out.minor = parseMinor(minor);
  }
  const labelsText = params.get('labels');
  const labels = LABEL_DENSITIES.find((density) => String(density) === labelsText);
  if (labels !== undefined) {
    out.labels = labels;
  }
  const lang = parseEnum(params.get('lang'), LANGS);
  if (lang !== undefined) {
    out.lang = lang;
  }
  parseNight(params.get('night'), out);
  const sel = params.get('sel');
  if (sel !== null && SEL_RE.test(sel)) {
    out.sel = sel;
  }
  return out;
}

type UrlValue = UrlState[keyof UrlState];

function sameValue(a: UrlValue, b: UrlValue): boolean {
  if (typeof a === 'object' && typeof b === 'object') {
    // Lists (`layers`, `dso`, `minor`) compare element-wise; both are already canonical.
    const left: readonly string[] = a;
    const right: readonly string[] = b;
    return left.length === right.length && left.every((item, i) => item === right[i]);
  }
  return a === b;
}

/**
 * `true` when both states carry the same keys with the same (unrounded) values. `nightLevel` is
 * not a query key of its own (it travels inside `night`) and is compared explicitly.
 */
export function urlStatesEqual(a: UrlState, b: UrlState): boolean {
  return a.nightLevel === b.nightLevel && URL_KEYS.every((key) => sameValue(a[key], b[key]));
}

/** `night` on: `1` at full brightness, the two-decimal level below it (`night=0.6`, plan D108). */
function formatNight(nightLevel: number | undefined): string {
  const level = nightLevel === undefined ? 1 : roundUrlValue('nightLevel', nightLevel);
  return level < 1 ? String(level) : '1';
}

/** The textual form of one present value. */
function formatValue(key: keyof UrlState, value: Exclude<UrlValue, undefined>): string {
  if (typeof value === 'boolean') {
    return value ? '1' : '0';
  }
  if (typeof value === 'number') {
    const rounded = roundUrlValue(key, value);
    // Rounding can land on the wrap boundary (359.996 -> 360, 179.996 -> 180): wrap afterwards.
    if (key === 'az') {
      return String(wrapAzimuthDeg(rounded));
    }
    if (key === 'lon') {
      return String(wrapLongitudeDeg(rounded));
    }
    return String(rounded);
  }
  if (typeof value === 'string') {
    return value;
  }
  const list: readonly string[] = value;
  return list.join(',');
}

/** `encodeURIComponent`, then `,` `:` `/` restored: they are legal in a query and read better. */
function encodeReadable(text: string): string {
  return encodeURIComponent(text).replace(/%2C/gi, ',').replace(/%3A/gi, ':').replace(/%2F/gi, '/');
}

/**
 * Serialize a state in the fixed `URL_KEYS` order without the leading `?`. Keys equal to their
 * default are omitted, except the observer, `t`, the view and `lang` (`ALWAYS_WRITTEN`, plan Q32).
 */
export function serializeUrlState(state: UrlState, defaults: UrlState): string {
  const parts: string[] = [];
  for (const key of URL_KEYS) {
    const value = state[key];
    if (value === undefined) {
      continue;
    }
    if (!ALWAYS_WRITTEN.has(key) && sameValue(value, defaults[key])) {
      continue;
    }
    const text =
      key === 'night' && value === true ? formatNight(state.nightLevel) : formatValue(key, value);
    parts.push(`${key}=${encodeReadable(text)}`);
  }
  return parts.join('&');
}

// Typed dynamic translation keys (UX-1, plan D109): the constellation abbreviations are the keys
// of `constellations.*` in en.json, the body ids the closed list of `/meta.bodies` (their
// `bodies.*` keys are area A's), and the object kinds the `kinds.*` keys. Every call site keeps a
// literal prefix (`t(\`constellations.${abbr}\`)`) so `scripts/check_i18n.mjs` counts the keys as
// used; the runtime guards narrow a string from the API or the URL to the union first. The
// resource file is already bundled by `i18n/index.ts`, so reading its keys here costs nothing.

import type { TFunction } from 'i18next';

import type { components } from '../api/schema';
import type { ArError, CompassLevel } from '../state/types';
import en from './en.json';

type BodyMeta = components['schemas']['BodyMeta'];

export type ConstellationAbbr = keyof typeof en.constellations;

const CONSTELLATION_ABBRS: ReadonlySet<string> = new Set(Object.keys(en.constellations));

export function isConstellationAbbr(value: string): value is ConstellationAbbr {
  return CONSTELLATION_ABBRS.has(value);
}

/** The bodies of `/meta.bodies` (brief l.126): the `bodies.*` keys of the resource files. */
export const BODY_KEYS = [
  'sun',
  'mercury',
  'venus',
  'earth',
  'moon',
  'mars',
  'jupiter',
  'saturn',
  'uranus',
  'neptune',
  'pluto',
] as const;
export type BodyKey = (typeof BODY_KEYS)[number];

export function isBodyKey(value: string): value is BodyKey {
  return (BODY_KEYS as readonly string[]).includes(value);
}

/** The object kinds shown in the details panel and the search results (`kinds.*`). */
export const KIND_KEYS = [
  'star',
  'dso',
  'planet',
  'dwarf_planet',
  'moon',
  'sun',
  'asteroid',
  'comet',
  'constellation',
] as const;
export type KindKey = (typeof KIND_KEYS)[number];

export function isKindKey(value: string): value is KindKey {
  return (KIND_KEYS as readonly string[]).includes(value);
}

/** `true` only when `A` and `B` are the same union (the `state/frames.ts` idiom). */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;

/**
 * Every `ArError` code (plan D115): the `ar.error.*` keys of the resource files (area D adds
 * them; the banner keeps the literal prefix `t(\`ar.error.${code}\`)`). `satisfies` refuses a
 * stranger and `ArErrorKeysComplete` a missing one.
 */
export const AR_ERROR_KEYS = [
  'noCamera',
  'noRearCamera',
  'cameraDenied',
  'cameraUnavailable',
  'trackEnded',
  'orientationDenied',
  'orientationUnavailable',
  'xrUnsupported',
  'xrDenied',
  'xrBusy',
  'xrFailed',
] as const satisfies readonly ArError[];
export type ArErrorKeysComplete = Assert<
  MutuallyAssignable<ArError, (typeof AR_ERROR_KEYS)[number]>
>;

export function isArErrorKey(value: string): value is ArError {
  return (AR_ERROR_KEYS as readonly string[]).includes(value);
}

/** Every `CompassLevel` (plan D118): the `ar.compass.*` keys of the resource files (area D). */
export const COMPASS_LEVELS = [
  'good',
  'fair',
  'poor',
  'invalid',
  'manual',
  'none',
] as const satisfies readonly CompassLevel[];
export type CompassLevelsComplete = Assert<
  MutuallyAssignable<CompassLevel, (typeof COMPASS_LEVELS)[number]>
>;

export function isCompassLevel(value: string): value is CompassLevel {
  return (COMPASS_LEVELS as readonly string[]).includes(value);
}

/** `kinds.*` key of a body: the Sun is a `star` in `/meta.bodies` but reads as "Sun". */
export function bodyKindKey(body: Pick<BodyMeta, 'id' | 'kind'>): KindKey {
  if (body.id === 'sun' || body.kind === 'star') {
    return 'sun';
  }
  return body.kind;
}

/** The translated name of a body id; the id itself when it has no key (a future body). */
export function bodyName(id: string, t: TFunction): string {
  return isBodyKey(id) ? t(`bodies.${id}`, { defaultValue: id }) : id;
}

/** The translated name of a constellation abbreviation; the abbreviation when unknown. */
export function constellationName(abbr: string, t: TFunction): string {
  return isConstellationAbbr(abbr) ? t(`constellations.${abbr}`) : abbr;
}

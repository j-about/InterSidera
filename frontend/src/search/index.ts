// The local search index (INFO-2, plan D107): built from the catalogs already in the browser
// (the star name index, the deep-sky objects, the constellations) and the bodies of `/meta`
// minus the observer's own (naming it as a target is a 400), ranked exact > prefix > substring
// then brighter first. About 22,000 normalised strings: a synchronous scan per keystroke costs
// a few milliseconds, so there is no debounce on the local half. The translated names
// (constellations, bodies) come through `SearchNames`, so this module imports no i18next and
// the caller rebuilds the index when the language or the observer body changes.

import type { CatalogBundle, DsoEntry, StarIndexEntry } from '../api/catalogs';
import type { components } from '../api/schema';
import { bodyKindKey } from '../i18n/keys';
import type { KindKey } from '../i18n/keys';
import { at } from '../sky/math/typed';
import { bayerVariants, normalizeText, spacedDsoId } from './normalize';

type BodyMeta = components['schemas']['BodyMeta'];

export type SearchKind = 'star' | 'dso' | 'body' | 'constellation' | 'minor';
export type { KindKey } from '../i18n/keys';

export interface SearchHit {
  /** The `sel` / `/sky/altaz` target id (`hip:27989`, `dso:NGC224`, `jupiter`, `a:1`), or `con:<abbr>`. */
  id: string;
  kind: SearchKind;
  kindKey: KindKey;
  /** Primary name as shown. */
  label: string;
  /** Secondary designations as shown (data, untranslated), empty when none. */
  sub: string;
  /** 3 exact, 2 prefix, 1 substring. */
  score: number;
  /** Ranking magnitude: catalog magnitude, 20 for a deep-sky object without one, -30 for bodies and constellations. */
  mag: number;
}

interface IndexEntry {
  id: string;
  kind: SearchKind;
  kindKey: KindKey;
  label: string;
  sub: string;
  mag: number;
  /** Normalised searchable spellings. */
  keys: readonly string[];
}

export interface SearchIndex {
  readonly entries: readonly IndexEntry[];
  /** Number of normalised strings held. */
  readonly size: number;
}

/** Translated names the index needs (the caller binds them to `t`). */
export interface SearchNames {
  constellation(abbr: string): string;
  body(id: string): string;
}

/** Deep-sky objects without a magnitude rank after every measured one (plan D107). */
export const DSO_UNKNOWN_MAG = 20;
/** Bodies and constellations rank before every star of the same score. */
export const FIRST_RANK_MAG = -30;
/** Default number of hits returned. */
export const DEFAULT_LIMIT = 8;

const SEPARATOR = ' · ';

function pushUnique(list: string[], value: string): void {
  if (value !== '' && !list.includes(value)) {
    list.push(value);
  }
}

function starEntry(
  star: StarIndexEntry,
  bundle: CatalogBundle,
  genitives: ReadonlyMap<string, string>,
): IndexEntry {
  const { proper, bayer, flamsteed } = star.names;
  const hip = `HIP ${String(star.hip)}`;
  const designations: string[] = [];
  const keys: string[] = [];
  if (typeof proper === 'string' && proper !== '') {
    pushUnique(keys, normalizeText(proper));
  }
  if (typeof bayer === 'string' && bayer !== '') {
    designations.push(bayer);
    for (const variant of bayerVariants(bayer, genitives.get(star.con))) {
      pushUnique(keys, variant);
    }
  }
  if (typeof flamsteed === 'string' && flamsteed !== '') {
    designations.push(flamsteed);
    pushUnique(keys, normalizeText(flamsteed));
  }
  designations.push(hip);
  pushUnique(keys, normalizeText(hip));
  const label =
    typeof proper === 'string' && proper !== '' ? proper : (designations.shift() ?? hip);
  const row = bundle.stars.hipIndex.get(star.hip);
  const mag = row === undefined ? DSO_UNKNOWN_MAG : at(bundle.stars.columns.mag, row) / 1000;
  return {
    id: `hip:${String(star.hip)}`,
    kind: 'star',
    kindKey: 'star',
    label,
    sub: designations.join(SEPARATOR),
    mag,
    keys,
  };
}

function dsoEntry(dso: DsoEntry): IndexEntry {
  const spaced = spacedDsoId(dso.id);
  const messier =
    dso.messier !== undefined && dso.messier !== null ? `M ${String(dso.messier)}` : null;
  const names = dso.names.filter((name) => name !== '');
  const designations: string[] = [];
  if (messier !== null) {
    designations.push(messier);
  }
  designations.push(spaced);
  const keys: string[] = [normalizeText(dso.id), normalizeText(spaced)];
  if (messier !== null) {
    pushUnique(keys, normalizeText(messier));
    pushUnique(keys, normalizeText(messier.replace(' ', '')));
    pushUnique(keys, normalizeText(`messier ${String(dso.messier)}`));
  }
  for (const name of names) {
    pushUnique(keys, normalizeText(name));
  }
  const label = names[0] ?? designations[0] ?? spaced;
  const sub = (names.length > 0 ? designations : designations.slice(1)).concat(names.slice(1));
  return {
    id: `dso:${dso.id}`,
    kind: 'dso',
    kindKey: 'dso',
    label,
    sub: sub.join(SEPARATOR),
    mag: dso.mag ?? DSO_UNKNOWN_MAG,
    keys,
  };
}

/**
 * Build the index from the loaded catalogs (`bundle`), the bodies of `/meta` minus the observer's
 * own, and the translated names of the current language.
 */
export function buildSearchIndex(
  bundle: CatalogBundle,
  bodies: readonly BodyMeta[],
  observerBody: string,
  names: SearchNames,
): SearchIndex {
  const entries: IndexEntry[] = [];
  const genitives = new Map<string, string>();
  for (const con of bundle.constellations?.data ?? []) {
    genitives.set(con.abbr, con.genitive);
  }
  for (const body of bodies) {
    if (body.id === observerBody) {
      continue;
    }
    const label = names.body(body.id);
    const keys: string[] = [];
    pushUnique(keys, normalizeText(label));
    pushUnique(keys, normalizeText(body.id));
    entries.push({
      id: body.id,
      kind: 'body',
      kindKey: bodyKindKey(body),
      label,
      sub: '',
      mag: FIRST_RANK_MAG,
      keys,
    });
  }
  for (const con of bundle.constellations?.data ?? []) {
    const label = names.constellation(con.abbr);
    const keys: string[] = [];
    pushUnique(keys, normalizeText(label));
    pushUnique(keys, normalizeText(con.latin));
    pushUnique(keys, normalizeText(con.genitive));
    pushUnique(keys, normalizeText(con.abbr));
    entries.push({
      id: `con:${con.abbr}`,
      kind: 'constellation',
      kindKey: 'constellation',
      label,
      sub: label === con.latin ? con.genitive : `${con.latin}${SEPARATOR}${con.genitive}`,
      mag: FIRST_RANK_MAG,
      keys,
    });
  }
  for (const star of bundle.index.data) {
    entries.push(starEntry(star, bundle, genitives));
  }
  for (const dso of bundle.dso?.data ?? []) {
    entries.push(dsoEntry(dso));
  }
  let size = 0;
  for (const entry of entries) {
    size += entry.keys.length;
  }
  return { entries, size };
}

/** 3 when a spelling equals the query, 2 when one starts with it, 1 when one contains it. */
function scoreOf(keys: readonly string[], query: string): number {
  let best = 0;
  for (const key of keys) {
    if (key === query) {
      return 3;
    }
    if (key.startsWith(query)) {
      best = 2;
    } else if (best < 1 && key.includes(query)) {
      best = 1;
    }
  }
  return best;
}

function compareHits(a: SearchHit, b: SearchHit): number {
  if (a.score !== b.score) {
    return b.score - a.score;
  }
  if (a.mag !== b.mag) {
    return a.mag - b.mag;
  }
  return a.label.localeCompare(b.label);
}

/** The best `limit` hits for `query` (an empty or blank query yields none). */
export function searchIndex(index: SearchIndex, query: string, limit = DEFAULT_LIMIT): SearchHit[] {
  const q = normalizeText(query);
  if (q === '') {
    return [];
  }
  const hits: SearchHit[] = [];
  for (const entry of index.entries) {
    const score = scoreOf(entry.keys, q);
    if (score > 0) {
      hits.push({
        id: entry.id,
        kind: entry.kind,
        kindKey: entry.kindKey,
        label: entry.label,
        sub: entry.sub,
        score,
        mag: entry.mag,
      });
    }
  }
  hits.sort(compareHits);
  return hits.length > limit ? hits.slice(0, limit) : hits;
}

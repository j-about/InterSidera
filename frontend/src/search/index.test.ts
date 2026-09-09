// @vitest-environment node
import { FAKE_BODIES, fakeBundle } from '../test/fakeBundle';
import { DSO_UNKNOWN_MAG, FIRST_RANK_MAG, buildSearchIndex, searchIndex } from './index';
import type { SearchIndex, SearchNames } from './index';

const EN: SearchNames = {
  constellation: (abbr) => ({ Ori: 'Orion', And: 'Andromeda', CMa: 'Canis Major' })[abbr] ?? abbr,
  body: (id) => ({ jupiter: 'Jupiter', earth: 'Earth', sun: 'Sun', moon: 'Moon' })[id] ?? id,
};
const FR: SearchNames = {
  constellation: (abbr) => ({ Ori: 'Orion', And: 'Andromède', CMa: 'Grand Chien' })[abbr] ?? abbr,
  body: (id) => ({ jupiter: 'Jupiter', earth: 'Terre', sun: 'Soleil', moon: 'Lune' })[id] ?? id,
};

function ids(index: SearchIndex, query: string, limit?: number): string[] {
  return searchIndex(index, query, limit).map((hit) => hit.id);
}

describe('buildSearchIndex / searchIndex', () => {
  const index = buildSearchIndex(fakeBundle(), FAKE_BODIES, 'earth', EN);

  it('indexes stars, deep-sky objects, constellations and the bodies but the observer', () => {
    const kinds = new Map<string, number>();
    for (const entry of index.entries) {
      kinds.set(entry.kind, (kinds.get(entry.kind) ?? 0) + 1);
    }
    expect(kinds.get('star')).toBe(7);
    expect(kinds.get('dso')).toBe(5);
    expect(kinds.get('constellation')).toBe(7);
    expect(kinds.get('body')).toBe(10);
    expect(index.entries.some((entry) => entry.id === 'earth')).toBe(false);
    expect(index.size).toBeGreaterThan(index.entries.length);
  });

  it('finds Betelgeuse by proper name, Bayer letter, Bayer name, Flamsteed and HIP', () => {
    for (const query of [
      'betelgeuse',
      'Betelgeuse',
      'alpha ori',
      'alp ori',
      'α Ori',
      'Alpha Orionis',
      '58 Ori',
      'HIP 27989',
      'hip 27989',
    ]) {
      expect(ids(index, query)[0], query).toBe('hip:27989');
    }
    const [hit] = searchIndex(index, 'betelgeuse');
    expect(hit).toMatchObject({
      id: 'hip:27989',
      kind: 'star',
      kindKey: 'star',
      label: 'Betelgeuse',
      sub: 'α Ori · 58 Ori · HIP 27989',
      score: 3,
    });
    expect(hit?.mag).toBeCloseTo(0.45, 6);
  });

  it('finds the superscripted Bayer designation as digits', () => {
    expect(ids(index, 'kappa1 scl')).toEqual(['hip:5896']);
    expect(ids(index, 'κ¹ Scl')).toEqual(['hip:5896']);
    const [hit] = searchIndex(index, 'kap1 scl');
    expect(hit?.label).toBe('κ¹ Scl');
    expect(hit?.sub).toBe('HIP 5896');
  });

  it('finds M31 by Messier number, NGC id (spaced or not) and common name', () => {
    for (const query of [
      'M31',
      'M 31',
      'm31',
      'messier 31',
      'NGC 224',
      'ngc224',
      'Andromeda Galaxy',
    ]) {
      expect(ids(index, query)[0], query).toBe('dso:NGC224');
    }
    const [hit] = searchIndex(index, 'M31');
    expect(hit).toMatchObject({
      kind: 'dso',
      kindKey: 'dso',
      label: 'Andromeda Galaxy',
      sub: 'M 31 · NGC 224',
      mag: 3.44,
    });
    const [horsehead] = searchIndex(index, 'IC 434');
    expect(horsehead).toMatchObject({
      id: 'dso:IC434',
      label: 'IC 434',
      sub: '',
      mag: DSO_UNKNOWN_MAG,
    });
  });

  it('finds a constellation by Latin, translated name, genitive and abbreviation', () => {
    for (const query of ['orion', 'Orion', 'Orionis', 'ori']) {
      expect(ids(index, query)[0], query).toBe('con:Ori');
    }
    const [hit] = searchIndex(index, 'orion');
    expect(hit).toMatchObject({
      kind: 'constellation',
      kindKey: 'constellation',
      label: 'Orion',
      sub: 'Orionis',
      score: 3,
      mag: FIRST_RANK_MAG,
    });
    const [cma] = searchIndex(index, 'canis major');
    expect(cma?.sub).toBe('Canis Majoris');
  });

  it('finds a body by its translated name and its id, never the observer', () => {
    expect(ids(index, 'jupiter')).toEqual(['jupiter']);
    expect(ids(index, 'Jupiter')[0]).toBe('jupiter');
    expect(ids(index, 'earth')).toEqual([]);
    const [sun] = searchIndex(index, 'sun');
    expect(sun).toMatchObject({ id: 'sun', kind: 'body', kindKey: 'sun', label: 'Sun' });
    const [moon] = searchIndex(index, 'moon');
    expect(moon?.kindKey).toBe('moon');
  });

  it('includes the Earth when the observer stands elsewhere', () => {
    const fromMars = buildSearchIndex(fakeBundle(), FAKE_BODIES, 'mars', EN);
    expect(ids(fromMars, 'earth')).toEqual(['earth']);
    expect(ids(fromMars, 'mars')).toEqual([]);
  });

  it('ranks exact before prefix before substring, then brighter first', () => {
    // "ori": Orion (prefix, first rank) before the stars whose Bayer text contains it, by magnitude.
    const result = ids(index, 'ori');
    expect(result[0]).toBe('con:Ori');
    const stars = result.filter((id) => id.startsWith('hip:'));
    // Sirius qualifies too: "alpha canis majoris" contains "ori".
    expect(stars).toContain('hip:27989');
    // "a": every prefix match (Andromeda, Alnitak, Andromeda Galaxy...) comes before substring ones.
    const scores = searchIndex(index, 'a', 100).map((hit) => hit.score);
    expect(scores).toEqual([...scores].sort((x, y) => y - x));
    // Rigel (0.18) before Betelgeuse (0.45) at equal score.
    const oriStars = searchIndex(index, 'ori', 100).filter((hit) => hit.kind === 'star');
    expect(oriStars.map((hit) => hit.mag)).toEqual(
      [...oriStars.map((hit) => hit.mag)].sort((x, y) => x - y),
    );
  });

  it('limits the hits and answers nothing for a blank query', () => {
    expect(ids(index, 'a', 2)).toHaveLength(2);
    expect(searchIndex(index, '')).toEqual([]);
    expect(searchIndex(index, '   ')).toEqual([]);
    expect(searchIndex(index, 'zzzz')).toEqual([]);
  });

  it('uses the translated names of the language it was built for', () => {
    const fr = buildSearchIndex(fakeBundle(), FAKE_BODIES, 'earth', FR);
    expect(ids(fr, 'Andromède')).toEqual(['con:And']);
    expect(ids(fr, 'andromede')[0]).toBe('con:And');
    expect(ids(fr, 'grand chien')).toEqual(['con:CMa']);
    expect(ids(fr, 'terre')).toEqual([]);
    expect(ids(fr, 'soleil')).toEqual(['sun']);
    // The Latin spelling is in every index (Sirius follows: "alpha canis majoris").
    expect(ids(fr, 'canis maj')[0]).toBe('con:CMa');
    expect(ids(fr, 'andromeda')[0]).toBe('con:And');
    expect(ids(index, 'andromède')).toEqual([]);
  });

  it('copes with a degraded bundle without deep-sky objects or constellations', () => {
    const degraded = buildSearchIndex(
      fakeBundle({ dso: false, constellations: false }),
      FAKE_BODIES,
      'earth',
      EN,
    );
    expect(ids(degraded, 'M31')).toEqual([]);
    expect(ids(degraded, 'orion')).toEqual([]);
    expect(ids(degraded, 'alpha orionis')).toEqual([]);
    expect(ids(degraded, 'alpha ori')[0]).toBe('hip:27989');
  });
});

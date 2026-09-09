// @vitest-environment node

import { EPHEMERIS_TT, makeMeta } from '../test/meta';
import { coverageYears, observerCoverage, withinCoverage } from './coverage';

// The editor's and the step buttons' range: ephemeris coverage intersected with the observer's.

describe('observerCoverage', () => {
  it('is null before /meta', () => {
    expect(observerCoverage(null, 'earth')).toBeNull();
  });

  it('is the ephemeris range for a body /meta does not list', () => {
    expect(observerCoverage(makeMeta(), 'vulcan')).toEqual(EPHEMERIS_TT);
  });

  it('intersects the ephemeris with the observer frame coverage', () => {
    const meta = makeMeta();
    const moon = meta.observers.find((o) => o.id === 'moon');
    if (moon === undefined) {
      throw new Error('no moon');
    }
    moon.coverage_tt = [EPHEMERIS_TT[0] + 1000, EPHEMERIS_TT[1] + 5000];
    expect(observerCoverage(meta, 'moon')).toEqual([EPHEMERIS_TT[0] + 1000, EPHEMERIS_TT[1]]);
    expect(observerCoverage(meta, 'earth')).toEqual(EPHEMERIS_TT);
  });
});

describe('withinCoverage and coverageYears', () => {
  it('includes the bounds and formats signed years', () => {
    expect(withinCoverage(EPHEMERIS_TT[0], EPHEMERIS_TT)).toBe(true);
    expect(withinCoverage(EPHEMERIS_TT[1], EPHEMERIS_TT)).toBe(true);
    expect(withinCoverage(EPHEMERIS_TT[0] - 1e-6, EPHEMERIS_TT)).toBe(false);
    expect(withinCoverage(EPHEMERIS_TT[1] + 1e-6, EPHEMERIS_TT)).toBe(false);
    expect(coverageYears(EPHEMERIS_TT)).toEqual({ start: '1849', end: '2150' });
    expect(coverageYears([-3100014.5, 8000015.5])).toEqual({ start: '-13200', end: '17191' });
  });
});

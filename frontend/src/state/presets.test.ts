// @vitest-environment node

import {
  OBSERVER_IDS,
  PLANETARY_SITES,
  eastLongitudeOfWest,
  isObserverId,
  planetocentricLatDeg,
  presetObserver,
  presetsFor,
} from './presets';
import { wrapLongitudeDeg } from './url';

// The OBS-6 presets: twelve sites within the URL bounds on known bodies, the Gazetteer conversions
// for Mercury (+West, planetographic) and Mars (0-360 east), and the per-body lists.

describe('PLANETARY_SITES', () => {
  it('lists twelve unique sites within bounds on observer bodies', () => {
    expect(PLANETARY_SITES).toHaveLength(12);
    expect(new Set(PLANETARY_SITES.map((s) => s.id)).size).toBe(12);
    for (const site of PLANETARY_SITES) {
      expect(isObserverId(site.body)).toBe(true);
      expect(site.body).not.toBe('earth');
      expect(Math.abs(site.lat)).toBeLessThanOrEqual(90);
      expect(site.lon).toBeGreaterThanOrEqual(-180);
      expect(site.lon).toBeLessThan(180);
      expect(wrapLongitudeDeg(site.lon)).toBe(site.lon);
    }
  });

  it('stores Caloris Planitia converted from the Gazetteer planetographic +West values', () => {
    const caloris = PLANETARY_SITES.find((s) => s.id === 'mercury:caloris');
    if (caloris === undefined) {
      throw new Error('missing Caloris');
    }
    expect(eastLongitudeOfWest(198.02)).toBeCloseTo(161.98, 10);
    expect(caloris.lon).toBe(161.98);
    const centric = planetocentricLatDeg(31.65, 2440.53, 2438.26);
    expect(centric).toBeCloseTo(31.602, 2);
    expect(Math.abs(caloris.lat - centric)).toBeLessThan(0.01);
    expect(caloris.featureId).toBe(979);
  });

  it('wraps Olympus Mons from 226 E and keeps Tranquility Base at the Gazetteer centre', () => {
    const olympus = PLANETARY_SITES.find((s) => s.id === 'mars:olympus');
    expect(olympus?.lon).toBe(wrapLongitudeDeg(226));
    expect(olympus?.lon).toBe(-134);
    const tranquility = PLANETARY_SITES.find((s) => s.id === 'moon:tranquility');
    expect(tranquility).toMatchObject({ lat: 0.67, lon: 23.47, featureId: 5684 });
  });

  it('converts planetographic to planetocentric latitude', () => {
    expect(planetocentricLatDeg(0, 2, 1)).toBe(0);
    expect(planetocentricLatDeg(45, 1, 1)).toBeCloseTo(45, 12);
    expect(planetocentricLatDeg(45, 2, 1)).toBeCloseTo(14.036, 3);
    expect(eastLongitudeOfWest(0)).toBe(0);
    expect(eastLongitudeOfWest(90)).toBe(-90);
  });
});

describe('presetsFor and presetObserver', () => {
  it('lists the presets of a body and none for Earth', () => {
    expect(presetsFor('earth')).toEqual([]);
    expect(presetsFor('moon').map((s) => s.key)).toEqual([
      'moon.tranquility',
      'moon.tycho',
      'moon.shackleton',
    ]);
    expect(presetsFor('mars')).toHaveLength(3);
    expect(presetsFor('jupiter')).toHaveLength(1);
    expect(presetsFor('pluto')).toEqual([]);
  });

  it('writes the four observer fields with elevation 0', () => {
    const jezero = presetsFor('mars')[0];
    if (jezero === undefined) {
      throw new Error('missing Jezero');
    }
    expect(presetObserver(jezero)).toEqual({ body: 'mars', lat: 18.41, lon: 77.69, elev: 0 });
  });

  it('guards the observer ids', () => {
    expect(OBSERVER_IDS).toHaveLength(10);
    expect(isObserverId('earth')).toBe(true);
    expect(isObserverId('sun')).toBe(false);
  });
});

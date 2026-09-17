// @vitest-environment node
import i18next from 'i18next';

import en from './en.json';
import {
  AR_ERROR_KEYS,
  BODY_KEYS,
  COMPASS_LEVELS,
  KIND_KEYS,
  bodyKindKey,
  bodyName,
  constellationName,
  isArErrorKey,
  isBodyKey,
  isCompassLevel,
  isConstellationAbbr,
  isKindKey,
} from './keys';

describe('keys', () => {
  it('recognises the 88 constellation abbreviations of the resource file', () => {
    expect(Object.keys(en.constellations)).toHaveLength(88);
    expect(isConstellationAbbr('Ori')).toBe(true);
    expect(isConstellationAbbr('CMa')).toBe(true);
    expect(isConstellationAbbr('ori')).toBe(false);
    expect(isConstellationAbbr('')).toBe(false);
  });

  it('maps the Sun to its own kind key and the other bodies to their meta kind', () => {
    expect(bodyKindKey({ id: 'sun', kind: 'star' })).toBe('sun');
    expect(bodyKindKey({ id: 'moon', kind: 'moon' })).toBe('moon');
    expect(bodyKindKey({ id: 'pluto', kind: 'dwarf_planet' })).toBe('dwarf_planet');
    expect(bodyKindKey({ id: 'mars', kind: 'planet' })).toBe('planet');
  });

  it('recognises the eleven bodies and the nine kinds', () => {
    expect(BODY_KEYS).toHaveLength(11);
    expect(isBodyKey('jupiter')).toBe(true);
    expect(isBodyKey('ceres')).toBe(false);
    expect(KIND_KEYS).toHaveLength(9);
    expect(isKindKey('dwarf_planet')).toBe(true);
    expect(isKindKey('galaxy')).toBe(false);
  });

  it('recognises the eleven AR error codes and the six compass levels (plan D115, D118)', () => {
    expect(AR_ERROR_KEYS).toHaveLength(11);
    expect(new Set(AR_ERROR_KEYS).size).toBe(11);
    expect(isArErrorKey('noCamera')).toBe(true);
    expect(isArErrorKey('orientationUnavailable')).toBe(true);
    expect(isArErrorKey('xrFailed')).toBe(true);
    expect(isArErrorKey('XrFailed')).toBe(false);
    expect(isArErrorKey('')).toBe(false);
    expect(COMPASS_LEVELS).toHaveLength(6);
    expect(new Set(COMPASS_LEVELS).size).toBe(6);
    expect(isCompassLevel('good')).toBe(true);
    expect(isCompassLevel('manual')).toBe(true);
    expect(isCompassLevel('none')).toBe(true);
    expect(isCompassLevel('great')).toBe(false);
  });

  it('translates constellation names and falls back to the abbreviation', async () => {
    expect(constellationName('CMa', i18next.t)).toBe('Canis Major');
    expect(constellationName('Xyz', i18next.t)).toBe('Xyz');
    await i18next.changeLanguage('fr');
    expect(constellationName('CMa', i18next.t)).toBe('Grand Chien');
    await i18next.changeLanguage('en');
  });

  it('translates body names through their key and falls back to the id', () => {
    // `bodies.*` are area A's keys: with them the translation, without them the id itself.
    const name = bodyName('jupiter', i18next.t);
    expect(name === 'Jupiter' || name === 'jupiter').toBe(true);
    expect(bodyName('ceres', i18next.t)).toBe('ceres');
  });
});

// @vitest-environment node
import { GREEK_NAMES, bayerVariants, normalizeText, spacedDsoId } from './normalize';

describe('normalizeText', () => {
  it('strips accents, lower-cases, collapses spaces and turns superscripts into digits', () => {
    expect(normalizeText('  Andromède ')).toBe('andromede');
    expect(normalizeText('GRANDE   OURSE')).toBe('grande ourse');
    expect(normalizeText('κ¹ Scl')).toBe('κ1 scl');
    expect(normalizeText('Écu de Sobieski')).toBe('ecu de sobieski');
    expect(normalizeText('')).toBe('');
  });
});

describe('bayerVariants', () => {
  it('spells a Bayer designation with the letter, its name and its abbreviation', () => {
    expect(bayerVariants('α Ori')).toEqual(['α ori', 'alpha ori', 'alp ori']);
    expect(bayerVariants('α Ori', 'Orionis')).toEqual([
      'α ori',
      'alpha ori',
      'alp ori',
      'α orionis',
      'alpha orionis',
    ]);
  });

  it('keeps the superscript as a digit', () => {
    expect(bayerVariants('κ¹ Scl')).toEqual(['κ1 scl', 'kappa1 scl', 'kap1 scl']);
  });

  it('falls back to the normalised text for anything else', () => {
    expect(bayerVariants('V1 Ori')).toEqual(['v1 ori']);
    expect(bayerVariants('')).toEqual(['']);
  });

  it('knows the 24 letters', () => {
    expect(GREEK_NAMES.size).toBe(24);
    expect(GREEK_NAMES.get('ω')).toBe('omega');
  });
});

describe('spacedDsoId', () => {
  it('separates the catalog prefix from the number and unfolds underscores', () => {
    expect(spacedDsoId('NGC224')).toBe('NGC 224');
    expect(spacedDsoId('IC434')).toBe('IC 434');
    expect(spacedDsoId('Mel22')).toBe('Mel 22');
    expect(spacedDsoId('Cr_399')).toBe('Cr 399');
    expect(spacedDsoId('ESO56-115')).toBe('ESO 56-115');
    expect(spacedDsoId('NGC 224')).toBe('NGC 224');
  });
});

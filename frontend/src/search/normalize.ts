// Text normalisation of the unified search (INFO-2, plan D107): the query and every indexed
// name go through the same function, so "Andromède", "ANDROMEDE" and "andromede" meet, and a
// Bayer designation stored as `α Ori` or `κ¹ Scl` is reachable as "alpha ori", "alp ori" or
// "kappa1 scl". Pure and dependency-free.

/** Greek letters of the Bayer designations and their English names. */
export const GREEK_NAMES: ReadonlyMap<string, string> = new Map([
  ['α', 'alpha'],
  ['β', 'beta'],
  ['γ', 'gamma'],
  ['δ', 'delta'],
  ['ε', 'epsilon'],
  ['ζ', 'zeta'],
  ['η', 'eta'],
  ['θ', 'theta'],
  ['ι', 'iota'],
  ['κ', 'kappa'],
  ['λ', 'lambda'],
  ['μ', 'mu'],
  ['ν', 'nu'],
  ['ξ', 'xi'],
  ['ο', 'omicron'],
  ['π', 'pi'],
  ['ρ', 'rho'],
  ['σ', 'sigma'],
  ['τ', 'tau'],
  ['υ', 'upsilon'],
  ['φ', 'phi'],
  ['χ', 'chi'],
  ['ψ', 'psi'],
  ['ω', 'omega'],
]);

/**
 * Canonical form of a name or a query: compatibility decomposition (`NFKD` also turns the
 * superscripts `¹²³` of `κ¹ Scl` into digits), combining marks stripped (accents), lower case,
 * whitespace collapsed to single spaces and trimmed.
 */
export function normalizeText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const BAYER_RE = /^(\p{Script=Greek})([¹²³⁴⁵⁶⁷⁸⁹]?)\s+(\S+)$/u;

/**
 * The searchable spellings of a Bayer designation, normalised: the letter itself (`α ori`), its
 * English name (`alpha ori`), the three-letter abbreviation (`alp ori`) and, when the genitive of
 * the constellation is known, the full form (`alpha orionis`). An unparsable designation yields
 * its normalised text alone.
 */
export function bayerVariants(bayer: string, genitive?: string): string[] {
  const match = BAYER_RE.exec(bayer.trim());
  if (match === null) {
    return [normalizeText(bayer)];
  }
  const [, letter = '', superscript = '', abbr = ''] = match;
  const name = GREEK_NAMES.get(letter);
  const forms: string[] = [`${letter}${superscript} ${abbr}`];
  if (name !== undefined) {
    forms.push(`${name}${superscript} ${abbr}`, `${name.slice(0, 3)}${superscript} ${abbr}`);
  }
  if (genitive !== undefined && genitive !== '') {
    forms.push(`${letter}${superscript} ${genitive}`);
    if (name !== undefined) {
      forms.push(`${name}${superscript} ${genitive}`);
    }
  }
  return forms.map(normalizeText);
}

/**
 * The spaced spelling of a canonical OpenNGC id (docs/api.md): `NGC224` -> `NGC 224`,
 * `IC434` -> `IC 434`, `Mel22` -> `Mel 22`, `Cr_399` -> `Cr 399`, `ESO56-115` -> `ESO 56-115`.
 */
export function spacedDsoId(id: string): string {
  return id.replace(/_/g, ' ').replace(/^([A-Za-z]+)(\d)/, '$1 $2');
}

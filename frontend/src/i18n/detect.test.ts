// @vitest-environment node
import { detectLanguage } from './detect';

describe('detectLanguage', () => {
  it('takes the first browser language whose primary subtag is supported', () => {
    expect(detectLanguage(['fr-CA', 'en'], ['en', 'fr'])).toBe('fr');
    expect(detectLanguage(['de', 'en-US'], ['en', 'fr'])).toBe('en');
    expect(detectLanguage(['FR'], ['en', 'fr'])).toBe('fr');
  });

  it('falls back to the first supported language', () => {
    expect(detectLanguage(['de', 'it'], ['en', 'fr'])).toBe('en');
    expect(detectLanguage([], ['en', 'fr'])).toBe('en');
    expect(detectLanguage(['de'], ['fr', 'en'])).toBe('fr');
    expect(detectLanguage(['de'], [])).toBe('en');
  });
});

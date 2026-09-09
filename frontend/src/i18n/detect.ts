import type { Lang } from '../state/types';

// Language detection (UX-1, plan D109): the first entry of `navigator.languages` whose primary
// subtag (`fr-CA` -> `fr`) is a supported language wins; otherwise the first supported one
// (English). The URL `lang` parameter takes precedence in `main.tsx`.

export function detectLanguage(languages: readonly string[], supported: readonly Lang[]): Lang {
  for (const tag of languages) {
    const primary = tag.toLowerCase().split('-')[0];
    const match = supported.find((lang) => lang === primary);
    if (match !== undefined) {
      return match;
    }
  }
  return supported[0] ?? 'en';
}

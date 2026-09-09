import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';

import { LANGS } from '../state/types';
import type { Lang } from '../state/types';
import en from './en.json';
import fr from './fr.json';

// Resources are bundled inline, so `init` resolves synchronously and its promise carries nothing
// we need: `void` it explicitly (strictTypeChecked forbids floating promises, plan D19).
// The URL `lang` parameter (or `detectLanguage(navigator.languages)` when absent) is applied by
// main.tsx before the first render; `state/domSync.ts` mirrors later changes of `options.lang`
// (the manual toggle) into `changeLanguage` and `documentElement.lang` (plan D109).

/** One resource file per entry of `LANGS` (UX-1): a language missing here fails to compile. */
const resources = { en: { translation: en }, fr: { translation: fr } } satisfies Record<
  Lang,
  { translation: object }
>;

void i18next.use(initReactI18next).init({
  resources,
  lng: 'en',
  fallbackLng: 'en',
  supportedLngs: [...LANGS],
  // React already escapes rendered strings; double escaping would corrupt apostrophes in French.
  interpolation: { escapeValue: false },
});

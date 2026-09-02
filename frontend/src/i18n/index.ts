import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';

import en from './en.json';
import fr from './fr.json';

// Resources are bundled inline, so `init` resolves synchronously and its promise carries nothing
// we need: `void` it explicitly (strictTypeChecked forbids floating promises, plan D19).
// Language detection and the URL `lang` parameter arrive with the UI at M4.
void i18next.use(initReactI18next).init({
  resources: { en: { translation: en }, fr: { translation: fr } },
  lng: 'en',
  fallbackLng: 'en',
  supportedLngs: ['en', 'fr'],
  // React already escapes rendered strings; double escaping would corrupt apostrophes in French.
  interpolation: { escapeValue: false },
});

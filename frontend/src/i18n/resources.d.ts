import type en from './en.json';

// Typed translation keys: `t('app.title')` is checked against en.json at compile time. Since
// i18next 22 / react-i18next 12 the augmentation lives on the `i18next` module (react-i18next
// derives its `useTranslation` types from it). fr.json is kept in step by scripts/check_i18n.mjs.
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: { translation: typeof en };
  }
}

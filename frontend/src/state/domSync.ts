import i18next from 'i18next';

import type { SkyStore } from './storeTypes';

// Store -> document mirror (plan D108, D109): night mode as `data-mode="night"` on `<html>`, the
// night brightness as the `--night-brightness` variable the night tokens read (`app.css`), and
// the language as `lang` plus `i18next.changeLanguage`. Three selector subscriptions fired at
// once so the first paint is already right; React never touches `<html>` itself.

/** What the mirror needs from i18next (the real module satisfies it; tests inject a fake). */
export interface DomSyncI18n {
  changeLanguage(lang: string): Promise<unknown>;
}

export interface DomSyncOptions {
  i18n?: DomSyncI18n;
}

/** Start mirroring; the returned function stops the three subscriptions. */
export function startDomSync(
  store: SkyStore,
  root: HTMLElement = document.documentElement,
  options: DomSyncOptions = {},
): () => void {
  const i18n = options.i18n ?? i18next;
  const stops = [
    store.subscribe(
      (s) => s.options.night,
      (night) => {
        if (night) {
          root.dataset.mode = 'night';
        } else {
          delete root.dataset.mode;
        }
      },
      { fireImmediately: true },
    ),
    store.subscribe(
      (s) => s.options.nightLevel,
      (level) => {
        root.style.setProperty('--night-brightness', String(level));
      },
      { fireImmediately: true },
    ),
    store.subscribe(
      (s) => s.options.lang,
      (lang) => {
        root.lang = lang;
        // The resources are bundled, so the change cannot fail.
        void i18n.changeLanguage(lang);
      },
      { fireImmediately: true },
    ),
  ];
  return () => {
    for (const stop of stops) {
      stop();
    }
  };
}

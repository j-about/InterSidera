import { startDomSync } from './domSync';
import type { DomSyncI18n } from './domSync';
import { createSkyStore } from './store';

// The store -> document mirror (plan D108, D109) against a detached root and a fake i18next.

function fakeI18n(): DomSyncI18n & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    changeLanguage: (lang: string) => {
      calls.push(lang);
      return Promise.resolve();
    },
  };
}

describe('startDomSync', () => {
  it('writes the initial state at once: no night, full brightness, the language', () => {
    const root = document.createElement('div');
    const i18n = fakeI18n();
    const store = createSkyStore({ lang: 'fr' });
    startDomSync(store, root, { i18n });
    expect(root.dataset.mode).toBeUndefined();
    expect(root.style.getPropertyValue('--night-brightness')).toBe('1');
    expect(root.lang).toBe('fr');
    expect(i18n.calls).toEqual(['fr']);
  });

  it('mirrors night mode, its brightness and the language as they change', () => {
    const root = document.createElement('div');
    const i18n = fakeI18n();
    const store = createSkyStore({ night: true, nightLevel: 0.6 });
    const stop = startDomSync(store, root, { i18n });
    expect(root.dataset.mode).toBe('night');
    expect(root.style.getPropertyValue('--night-brightness')).toBe('0.6');
    expect(root.lang).toBe('en');

    const { actions } = store.getState();
    actions.setNightLevel(0.45);
    expect(root.style.getPropertyValue('--night-brightness')).toBe('0.45');
    actions.setOptions({ night: false });
    expect(root.dataset.mode).toBeUndefined();
    expect(root.hasAttribute('data-mode')).toBe(false);
    actions.setOptions({ lang: 'fr' });
    expect(root.lang).toBe('fr');
    expect(i18n.calls).toEqual(['en', 'fr']);
    // An unrelated change wakes nothing.
    actions.setView({ az: 90 });
    expect(i18n.calls).toEqual(['en', 'fr']);

    stop();
    actions.setOptions({ night: true, lang: 'en' });
    actions.setNightLevel(0.9);
    expect(root.dataset.mode).toBeUndefined();
    expect(root.lang).toBe('fr');
    expect(root.style.getPropertyValue('--night-brightness')).toBe('0.45');
    expect(i18n.calls).toEqual(['en', 'fr']);
  });

  it('defaults to the document root and the real i18next', () => {
    const store = createSkyStore({ night: true });
    const stop = startDomSync(store);
    expect(document.documentElement.dataset.mode).toBe('night');
    expect(document.documentElement.lang).toBe('en');
    store.getState().actions.setOptions({ night: false });
    stop();
    expect(document.documentElement.dataset.mode).toBeUndefined();
  });
});

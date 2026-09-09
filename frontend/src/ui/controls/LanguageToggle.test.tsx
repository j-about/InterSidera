import { fireEvent, render, screen } from '@testing-library/react';

import { createSkyStore } from '../../state/store';
import LanguageToggle from './LanguageToggle';

describe('LanguageToggle', () => {
  it('offers one pressed button per language and writes options.lang', () => {
    const store = createSkyStore();
    render(<LanguageToggle store={store} />);
    const group = screen.getByRole('group', { name: 'Language' });
    const en = screen.getByRole('button', { name: 'English' });
    const fr = screen.getByRole('button', { name: 'Français' });
    expect(group).toContainElement(en);
    expect(en).toHaveAttribute('aria-pressed', 'true');
    expect(fr).toHaveAttribute('aria-pressed', 'false');
    expect(fr).toHaveAttribute('lang', 'fr');

    fireEvent.click(fr);
    expect(store.getState().options.lang).toBe('fr');
    expect(fr).toHaveAttribute('aria-pressed', 'true');
    expect(en).toHaveAttribute('aria-pressed', 'false');
  });

  it('leaves the store alone when the current language is pressed again', () => {
    const store = createSkyStore({ lang: 'fr' });
    const before = store.getState().options;
    render(<LanguageToggle store={store} />);
    fireEvent.click(screen.getByRole('button', { name: 'Français' }));
    expect(store.getState().options).toBe(before);
  });
});

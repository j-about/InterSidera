import { fireEvent, render, screen } from '@testing-library/react';

import { createSkyStore } from '../../state/store';
import TopBar from './TopBar';

describe('TopBar', () => {
  it('is the banner landmark holding the presets, night mode, export and About', () => {
    const store = createSkyStore();
    render(<TopBar store={store} />);
    const banner = screen.getByRole('banner');
    expect(banner).toContainElement(screen.getByRole('group', { name: 'Field of view' }));
    expect(banner).toContainElement(screen.getByRole('switch', { name: 'Night vision' }));
    expect(banner).toContainElement(screen.getByRole('button', { name: 'Export the view as PNG' }));
    // Every button carries a name (UX-4).
    for (const button of screen.getAllByRole('button')) {
      expect(button).toHaveAccessibleName();
    }
  });

  it('opens the About dialog and closes it through the store', () => {
    const store = createSkyStore();
    render(<TopBar store={store} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'About InterSidera' }));
    expect(store.getState().ui.dialog).toBe('about');
    const dialog = screen.getByRole('dialog', { name: 'About InterSidera' });
    expect(dialog).toHaveAttribute('open');

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(store.getState().ui.dialog).toBeNull();
    expect(dialog).not.toHaveAttribute('open');
  });
});

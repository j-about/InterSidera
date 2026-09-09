import { fireEvent, render, screen } from '@testing-library/react';
import i18next from 'i18next';

import { createSkyStore } from '../../state/store';
import TimePanel from './TimePanel';

// The time panel: the editor button, the step buttons, the shortcut list and its switch.

describe('TimePanel', () => {
  it('opens the editor, lists the shortcuts and toggles them', () => {
    const store = createSkyStore();
    render(<TimePanel store={store} />);
    fireEvent.click(screen.getByRole('button', { name: 'Set date and time' }));
    expect(store.getState().ui.dialog).toBe('timeEditor');
    expect(screen.getByRole('button', { name: 'Forward: Hour' })).toBeInTheDocument();

    expect(
      screen.getByRole('heading', { level: 3, name: 'Keyboard shortcuts' }),
    ).toBeInTheDocument();
    expect(screen.getByText(i18next.t('shortcuts.space'))).toBeInTheDocument();
    expect(screen.getByText(i18next.t('shortcuts.escape'))).toBeInTheDocument();
    const toggle = screen.getByRole('switch', { name: 'Single-key shortcuts on' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(toggle);
    expect(store.getState().ui.shortcuts).toBe(false);
  });
});

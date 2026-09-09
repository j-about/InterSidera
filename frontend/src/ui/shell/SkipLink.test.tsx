import { fireEvent, render, screen } from '@testing-library/react';

import { createSkyStore } from '../../state/store';
import SkipLink from './SkipLink';

describe('SkipLink', () => {
  it('points at the panel, is hidden until focused and moves the focus there on click', () => {
    const store = createSkyStore();
    render(
      <>
        <SkipLink store={store} />
        <aside id="panel" tabIndex={-1}>
          panel
        </aside>
      </>,
    );
    const link = screen.getByRole('link', { name: 'Skip to the control panel' });
    expect(link).toHaveAttribute('href', '#panel');
    expect(link).toHaveClass('sr-only', 'focus:not-sr-only');

    const event = fireEvent.click(link);
    // The default navigation is prevented so the URL hash is never touched (plan D79).
    expect(event).toBe(false);
    expect(document.getElementById('panel')).toHaveFocus();
    expect(location.hash).toBe('');
    // On the phone the sheet opens so the focused panel is visible.
    expect(store.getState().ui.sheet).toBe('expanded');
  });
});

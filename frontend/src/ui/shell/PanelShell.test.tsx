import { act, fireEvent, render, screen } from '@testing-library/react';

import { createSkyStore } from '../../state/store';
import PanelShell from './PanelShell';

// Under jsdom `matchMedia` never matches (test setup), so this is the phone layout: the sheet
// handle and the strip render, the body follows `ui.sheet`.

describe('PanelShell', () => {
  it('is the complementary landmark, focusable, with the four tabs bound to ui.panel', () => {
    const store = createSkyStore();
    render(<PanelShell store={store} />);
    const aside = screen.getByRole('complementary', { name: 'Controls' });
    expect(aside).toHaveAttribute('id', 'panel');
    expect(aside).toHaveAttribute('tabindex', '-1');

    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Observer', 'Time', 'Layers', 'Details']);
    expect(screen.getByRole('tab', { name: 'Observer' })).toHaveAttribute('aria-selected', 'true');

    fireEvent.click(screen.getByRole('tab', { name: 'Time' }));
    expect(store.getState().ui.panel).toBe('time');
    expect(store.getState().ui.sheet).toBe('expanded');
    expect(screen.getByRole('tabpanel', { name: 'Time' })).toHaveTextContent('Set date and time');

    act(() => {
      store.getState().actions.openPanel('layers');
    });
    expect(screen.getByRole('tab', { name: 'Layers' })).toHaveAttribute('aria-selected', 'true');
  });

  it('collapses and expands the sheet from the handle and Escape', () => {
    const store = createSkyStore();
    render(<PanelShell store={store} />);
    const handle = screen.getByRole('button', { name: 'Expand the control panel' });
    expect(handle).toHaveAttribute('aria-expanded', 'false');
    expect(handle).toHaveAttribute('aria-controls', 'panel-body');
    expect(document.getElementById('panel-body')).toHaveClass('hidden');

    fireEvent.click(handle);
    expect(store.getState().ui.sheet).toBe('expanded');
    expect(handle).toHaveAttribute('aria-expanded', 'true');
    expect(handle).toHaveAccessibleName('Collapse the control panel');
    expect(document.getElementById('panel-body')).not.toHaveClass('hidden');

    fireEvent.keyDown(handle, { key: 'Escape' });
    expect(store.getState().ui.sheet).toBe('collapsed');
    expect(handle).toHaveAttribute('aria-expanded', 'false');
  });
});

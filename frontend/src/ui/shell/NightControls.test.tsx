import { act, fireEvent, render, screen } from '@testing-library/react';

import { createSkyStore } from '../../state/store';
import NightControls from './NightControls';

describe('NightControls', () => {
  it('toggles night mode and shows the brightness slider while on', () => {
    const store = createSkyStore();
    render(<NightControls store={store} />);
    const toggle = screen.getByRole('switch', { name: 'Night vision' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByRole('slider')).toBeNull();

    fireEvent.click(toggle);
    expect(store.getState().options.night).toBe(true);
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    const slider = screen.getByRole('slider', { name: 'Brightness' });
    expect(slider).toHaveValue('1');
    expect(slider).toHaveAttribute('min', '0.3');
    expect(slider).toHaveAttribute('max', '1');
    expect(slider).toHaveAttribute('aria-valuetext', '100%');

    fireEvent.change(slider, { target: { value: '0.5' } });
    expect(store.getState().options.nightLevel).toBe(0.5);
    expect(slider).toHaveAttribute('aria-valuetext', '50%');

    fireEvent.click(toggle);
    expect(store.getState().options.night).toBe(false);
    expect(screen.queryByRole('slider')).toBeNull();
    // The level survives a toggle (plan D108: only the flag leaves the URL).
    expect(store.getState().options.nightLevel).toBe(0.5);
  });

  it('reflects a night level loaded from the URL', () => {
    const store = createSkyStore({ night: true, nightLevel: 0.6 });
    render(<NightControls store={store} />);
    expect(screen.getByRole('switch', { name: 'Night vision' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('slider', { name: 'Brightness' })).toHaveValue('0.6');
    act(() => {
      store.getState().actions.setNightLevel(0.8);
    });
    expect(screen.getByRole('slider', { name: 'Brightness' })).toHaveValue('0.8');
  });
});

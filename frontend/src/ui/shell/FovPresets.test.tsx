import { act, fireEvent, render, screen } from '@testing-library/react';

import { createSkyStore } from '../../state/store';
import FovPresets, { pressedPreset } from './FovPresets';

describe('FovPresets', () => {
  it('offers the three presets as pressed buttons bound to the field of view', () => {
    const store = createSkyStore();
    render(<FovPresets store={store} />);
    expect(screen.getByRole('group', { name: 'Field of view' })).toBeInTheDocument();
    const naked = screen.getByRole('button', { name: 'Naked eye, 60°' });
    const binoculars = screen.getByRole('button', { name: 'Binoculars, 7°' });
    const telescope = screen.getByRole('button', { name: 'Telescope, 1°' });
    // The visible text is the angle, contained in the accessible name (WCAG 2.5.3).
    expect(naked).toHaveTextContent('60°');
    expect(naked).toHaveAttribute('aria-pressed', 'true');
    expect(binoculars).toHaveAttribute('aria-pressed', 'false');
    expect(telescope).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(binoculars);
    expect(store.getState().view.fov).toBe(7);
    expect(binoculars).toHaveAttribute('aria-pressed', 'true');
    expect(naked).toHaveAttribute('aria-pressed', 'false');

    // A view written by the camera (a zoom) is reflected; nothing is pressed between presets.
    act(() => {
      store.getState().actions.setView({ fov: 30 });
    });
    expect(screen.queryAllByRole('button', { pressed: true })).toHaveLength(0);
    act(() => {
      store.getState().actions.setView({ fov: 1.04 });
    });
    expect(telescope).toHaveAttribute('aria-pressed', 'true');
  });

  it('matches a preset within 0.05 degree', () => {
    expect(pressedPreset(60)).toBe(0);
    expect(pressedPreset(60.049)).toBe(0);
    expect(pressedPreset(60.06)).toBe(-1);
    expect(pressedPreset(7)).toBe(1);
    expect(pressedPreset(1)).toBe(2);
    expect(pressedPreset(45)).toBe(-1);
  });
});

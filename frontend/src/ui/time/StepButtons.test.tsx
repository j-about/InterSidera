import { act, fireEvent, render, screen } from '@testing-library/react';

import { createSkyStore } from '../../state/store';
import { EPHEMERIS_TT, makeMeta } from '../../test/meta';
import StepButtons from './StepButtons';

// The step buttons: one row per unit (the sidereal day on Earth only), `stepTime` deltas, the
// disabled state at the coverage bounds and the `[` / `]` unit selector.

const T0 = 1_757_000_000_000;
const TT = 2460409.25;

describe('StepButtons', () => {
  it('steps by every unit and hides the sidereal day off Earth', () => {
    const store = createSkyStore({ t: TT, speed: 0 }, T0);
    render(<StepButtons store={store} />);
    expect(screen.getByRole('button', { name: 'Forward: Sidereal day' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Forward: Hour' }));
    expect(store.getState().clock.ttAnchor).toBeCloseTo(TT + 1 / 24, 9);
    fireEvent.click(screen.getByRole('button', { name: 'Back: Minute' }));
    expect(store.getState().clock.ttAnchor).toBeCloseTo(TT + 1 / 24 - 1 / 1440, 9);
    fireEvent.click(screen.getByRole('button', { name: 'Forward: Sidereal day' }));
    expect(store.getState().clock.ttAnchor).toBeCloseTo(
      TT + 1 / 24 - 1 / 1440 + 86164.0905 / 86400,
      9,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Back: Day' }));
    fireEvent.click(screen.getByRole('button', { name: 'Forward: Year' }));
    // A calendar year later: 2025-04-08 (365 days).
    expect(store.getState().clock.ttAnchor).toBeCloseTo(
      TT + 1 / 24 - 1 / 1440 + 86164.0905 / 86400 - 1 + 365,
      6,
    );
    expect(store.getState().clock.mode).toBe('paused');

    act(() => {
      store.getState().actions.setObserver({ body: 'mars', lat: 0, lon: 0, elev: 0 });
    });
    expect(screen.queryByRole('button', { name: 'Forward: Sidereal day' })).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(8);
  });

  it('disables a step that would leave the coverage', () => {
    const store = createSkyStore({ t: EPHEMERIS_TT[1] - 0.5, speed: 0 }, T0);
    store.getState().actions.setMeta(makeMeta());
    render(<StepButtons store={store} />);
    expect(screen.getByRole('button', { name: 'Forward: Hour' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Forward: Day' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Forward: Year' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Back: Year' })).toBeEnabled();
    act(() => {
      store.getState().actions.setTime(EPHEMERIS_TT[0] + 0.01, T0);
      store.getState().actions.publishTt(EPHEMERIS_TT[0] + 0.01, NaN);
    });
    expect(screen.getByRole('button', { name: 'Back: Day' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Back: Minute' })).toBeEnabled();
  });

  it('binds the unit selector to ui.stepUnit and falls back to the hour off Earth', () => {
    const store = createSkyStore({ t: TT, speed: 0 }, T0);
    render(<StepButtons store={store} />);
    const select = screen.getByRole('combobox', { name: 'Step of [ and ]' });
    expect(select).toHaveValue('hour');
    fireEvent.change(select, { target: { value: 'siderealDay' } });
    expect(store.getState().ui.stepUnit).toBe('siderealDay');
    act(() => {
      store.getState().actions.setObserver({ body: 'venus', lat: 0, lon: 0, elev: 0 });
    });
    expect(select).toHaveValue('hour');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Minute',
      'Hour',
      'Day',
      'Year',
    ]);
  });
});

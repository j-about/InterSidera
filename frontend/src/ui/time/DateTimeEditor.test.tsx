import { act, fireEvent, render, screen } from '@testing-library/react';
import i18next from 'i18next';

import { createSkyStore } from '../../state/store';
import { ttFromUtcCalendar, utcCalendarOfTt } from '../../state/timeDisplay';
import { EPHEMERIS_TT, makeMeta } from '../../test/meta';
import DateTimeEditor from './DateTimeEditor';

// The editor: the draft from the clock on open (UTC or a fixed zone), Apply pausing at the
// instant, month 13 and an out-of-range year refused with the URL state untouched, a negative
// year accepted without coverage, the Gregorian notice, the local/UTC switch.

const T0 = 1_757_000_000_000;
const TT = 2460409.25;
const PLUS_TWO = (): number => 120;

function field(name: string): HTMLElement {
  return screen.getByRole('textbox', { name });
}

function type(name: string, value: string): void {
  fireEvent.change(field(name), { target: { value } });
}

function apply(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
}

describe('DateTimeEditor', () => {
  it('opens on the clock in the injected zone and applies a date inside the coverage', () => {
    const store = createSkyStore({ t: TT, speed: 0 }, T0);
    store.getState().actions.setMeta(makeMeta());
    render(<DateTimeEditor store={store} offsetAt={PLUS_TWO} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => {
      store.getState().actions.openDialog('timeEditor');
    });
    expect(screen.getByRole('dialog', { name: 'Set date and time' })).toBeInTheDocument();
    expect(field('Year')).toHaveValue('2024');
    expect(field('Month')).toHaveValue('4');
    expect(field('Day')).toHaveValue('8');
    expect(field('Hour')).toHaveValue('19');
    expect(field('Minute')).toHaveValue('58');
    expect(field('Second')).toHaveValue('50');
    expect(screen.getByTestId('time-editor-range')).toHaveTextContent(
      i18next.t('time.range', { start: '1849', end: '2150' }),
    );

    type('Year', '1900');
    type('Month', '1');
    type('Day', '1');
    type('Hour', '12');
    type('Minute', '0');
    type('Second', '0');
    apply();
    const expected = ttFromUtcCalendar(
      { year: 1900, month: 1, day: 1, hour: 10, minute: 0, second: 0 },
      69.184,
    );
    expect(store.getState().clock.mode).toBe('paused');
    expect(store.getState().clock.ttAnchor).toBeCloseTo(expected, 9);
    expect(store.getState().ui.dialog).toBeNull();
  });

  it('refuses month 13 and an out-of-range year, leaving the clock alone', () => {
    const store = createSkyStore({ t: TT, speed: 0 }, T0);
    store.getState().actions.setMeta(makeMeta());
    act(() => {
      store.getState().actions.openDialog('timeEditor');
    });
    render(<DateTimeEditor store={store} offsetAt={PLUS_TWO} />);
    type('Month', '13');
    apply();
    // The impossible date marks its field (WCAG 3.3.1, plan D157 C6): `aria-invalid`, described
    // by the message, which is the one alert; the five other fields stay valid.
    const invalid = i18next.t('time.error.invalidDate');
    expect(screen.getByRole('alert')).toHaveTextContent(invalid);
    expect(field('Month')).toHaveAttribute('aria-invalid', 'true');
    expect(field('Month')).toHaveAccessibleDescription(invalid);
    for (const name of ['Year', 'Day', 'Hour', 'Minute', 'Second']) {
      expect(field(name)).not.toHaveAttribute('aria-invalid');
    }
    expect(screen.queryByTestId('time-editor-error')).toBeNull();
    expect(store.getState().clock.ttAnchor).toBe(TT);
    expect(store.getState().ui.dialog).toBe('timeEditor');

    type('Month', '3');
    expect(field('Month')).not.toHaveAttribute('aria-invalid');
    type('Year', '-44');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText(i18next.t('time.gregorianNotice'))).toBeInTheDocument();
    apply();
    // A date outside the coverage is a property of the whole date: the form-level alert, no field.
    expect(screen.getByTestId('time-editor-error')).toHaveTextContent(
      i18next.t('time.error.range', { start: '1849', end: '2150' }),
    );
    expect(screen.getByRole('alert')).toBe(screen.getByTestId('time-editor-error'));
    expect(screen.queryByRole('textbox', { name: 'Year' })).not.toHaveAttribute('aria-invalid');
    expect(store.getState().clock.ttAnchor).toBe(TT);
    expect(store.getState().ui.dialog).toBe('timeEditor');

    type('Year', '2149');
    type('Month', '12');
    type('Day', '31');
    type('Hour', '12');
    type('Minute', '0');
    type('Second', '0');
    apply();
    // 2149-12-31 12:00 local (+2) lies a few weeks inside the coverage end.
    expect(store.getState().clock.ttAnchor).toBeLessThanOrEqual(EPHEMERIS_TT[1]);
    expect(store.getState().clock.ttAnchor).toBeGreaterThan(EPHEMERIS_TT[1] - 60);
    expect(store.getState().ui.dialog).toBeNull();
  });

  it('accepts a negative year without coverage and converts the draft on the UTC switch', () => {
    const store = createSkyStore({ t: TT, speed: 0 }, T0);
    render(<DateTimeEditor store={store} offsetAt={PLUS_TWO} />);
    act(() => {
      store.getState().actions.openDialog('timeEditor');
    });
    expect(screen.queryByTestId('time-editor-range')).toBeNull();
    const local = screen.getByRole('switch', { name: 'Local time' });
    expect(local).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(local);
    expect(field('Hour')).toHaveValue('17');
    // The typographic minus is a sign here as in the coordinate fields.
    type('Year', '\u221244');
    type('Month', '3');
    type('Day', '15');
    type('Hour', '12');
    type('Minute', '0');
    type('Second', '0');
    apply();
    const expected = ttFromUtcCalendar(
      { year: -44, month: 3, day: 15, hour: 12, minute: 0, second: 0 },
      69.184,
    );
    expect(store.getState().clock.ttAnchor).toBeCloseTo(expected, 9);
    expect(utcCalendarOfTt(store.getState().clock.ttAnchor, 69.184).year).toBe(-44);
  });

  it('keeps an invalid draft as typed when the scale switches and rebuilds it on reopen', () => {
    const store = createSkyStore({ t: TT, speed: 0 }, T0);
    render(<DateTimeEditor store={store} offsetAt={PLUS_TWO} />);
    act(() => {
      store.getState().actions.openDialog('timeEditor');
    });
    type('Day', 'x');
    fireEvent.click(screen.getByRole('switch', { name: 'Local time' }));
    expect(field('Day')).toHaveValue('x');
    fireEvent.submit(field('Day').closest('form') ?? field('Day'));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(field('Day')).toHaveAttribute('aria-invalid', 'true');
    act(() => {
      store.getState().actions.closeDialog();
    });
    act(() => {
      store.getState().actions.openDialog('timeEditor');
    });
    expect(field('Day')).toHaveValue('8');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(field('Day')).not.toHaveAttribute('aria-invalid');
    // Now in UTC: the hour is the UTC one.
    expect(field('Hour')).toHaveValue('17');
  });
});

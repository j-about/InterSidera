import { act, fireEvent, render, screen } from '@testing-library/react';
import i18next from 'i18next';

import { createSkyStore } from '../../state/store';
import CoordinateForm, { COORDINATE_DEBOUNCE_MS } from './CoordinateForm';

// Manual coordinates: the three fields show the observer, a valid entry reaches the store after
// the debounce (DMS included), errors are announced, the preview shows the rounded values, and an
// external observer change (a preset) replaces the drafts while the form's own write does not.

describe('CoordinateForm', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the observer and writes a DMS entry after the debounce', () => {
    const store = createSkyStore({ body: 'earth', lat: 51.48, lon: 0, elev: 0 });
    render(<CoordinateForm store={store} />);
    const lat = screen.getByRole('textbox', { name: 'Latitude' });
    const lon = screen.getByRole('textbox', { name: 'Longitude' });
    const elev = screen.getByRole('textbox', { name: 'Elevation (m)' });
    expect(lat).toHaveValue('51.48');
    expect(lon).toHaveValue('0');
    expect(elev).toHaveValue('0');

    fireEvent.change(lat, { target: { value: '48°51\'24"N' } });
    fireEvent.change(lon, { target: { value: '2°21\'03"E' } });
    fireEvent.change(elev, { target: { value: '35' } });
    expect(store.getState().observer.lat).toBe(51.48);
    act(() => {
      vi.advanceTimersByTime(COORDINATE_DEBOUNCE_MS);
    });
    const observer = store.getState().observer;
    expect(observer.body).toBe('earth');
    expect(observer.lat).toBeCloseTo(48 + 51 / 60 + 24 / 3600, 12);
    expect(observer.lon).toBeCloseTo(2 + 21 / 60 + 3 / 3600, 12);
    expect(observer.elev).toBe(35);
    // The form's own write keeps the typed text.
    expect(lat).toHaveValue('48°51\'24"N');
    expect(screen.getByTestId('coords-preview')).toHaveTextContent(
      i18next.t('coords.preview', { lat: '48.86', lon: '2.35', elev: '35' }),
    );
  });

  it('announces errors and writes nothing while a field is invalid', () => {
    const store = createSkyStore({ body: 'earth', lat: 51.48, lon: 0, elev: 0 });
    render(<CoordinateForm store={store} />);
    const lat = screen.getByRole('textbox', { name: 'Latitude' });
    fireEvent.change(lat, { target: { value: '91' } });
    expect(screen.getByRole('alert')).toHaveTextContent(i18next.t('coords.error.range'));
    expect(lat).toHaveAttribute('aria-invalid', 'true');
    fireEvent.change(screen.getByRole('textbox', { name: 'Longitude' }), {
      target: { value: '12 N' },
    });
    expect(screen.getAllByRole('alert')).toHaveLength(2);
    expect(screen.getAllByRole('alert')[1]).toHaveTextContent(i18next.t('coords.error.hemisphere'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Elevation (m)' }), {
      target: { value: '' },
    });
    expect(screen.getAllByRole('alert')[2]).toHaveTextContent(i18next.t('coords.error.empty'));
    act(() => {
      vi.advanceTimersByTime(COORDINATE_DEBOUNCE_MS * 2);
    });
    expect(store.getState().observer).toEqual({ body: 'earth', lat: 51.48, lon: 0, elev: 0 });
    // The preview keeps the store's values while the drafts are invalid.
    expect(screen.getByTestId('coords-preview')).toHaveTextContent(
      i18next.t('coords.preview', { lat: '51.48', lon: '0', elev: '0' }),
    );
  });

  it('follows an external observer change and keeps the body of a concurrent switch', () => {
    const store = createSkyStore({ body: 'earth', lat: 51.48, lon: 0, elev: 0 });
    render(<CoordinateForm store={store} />);
    act(() => {
      store.getState().actions.setObserver({ body: 'mars', lat: 18.41, lon: 77.69, elev: 0 });
    });
    expect(screen.getByRole('textbox', { name: 'Latitude' })).toHaveValue('18.41');
    expect(screen.getByRole('textbox', { name: 'Longitude' })).toHaveValue('77.69');

    fireEvent.change(screen.getByRole('textbox', { name: 'Latitude' }), {
      target: { value: '-5.44' },
    });
    // The body switches before the debounce fires: the write keeps the new body.
    act(() => {
      store.getState().actions.setObserver({ ...store.getState().observer, body: 'moon' });
    });
    act(() => {
      vi.advanceTimersByTime(COORDINATE_DEBOUNCE_MS);
    });
    expect(store.getState().observer).toEqual({ body: 'moon', lat: -5.44, lon: 77.69, elev: 0 });
  });

  it('does not write a value equal to the store and cancels the timer on unmount', () => {
    const store = createSkyStore({ body: 'earth', lat: 51.48, lon: 0, elev: 0 });
    const setObserver = vi.spyOn(store.getState().actions, 'setObserver');
    const view = render(<CoordinateForm store={store} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Latitude' }), {
      target: { value: '51.480' },
    });
    act(() => {
      vi.advanceTimersByTime(COORDINATE_DEBOUNCE_MS);
    });
    expect(setObserver).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Latitude' }), {
      target: { value: '40' },
    });
    view.unmount();
    act(() => {
      vi.advanceTimersByTime(COORDINATE_DEBOUNCE_MS);
    });
    expect(setObserver).not.toHaveBeenCalled();
  });
});

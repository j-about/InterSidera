import { act, fireEvent, render, screen } from '@testing-library/react';
import i18next from 'i18next';

import { createSkyStore } from '../../state/store';
import { makeMeta } from '../../test/meta';
import BodyPicker from './BodyPicker';

// The body picker: translated labels from `/meta.observers`, the latitude convention, the
// coverage as signed years, the approximation note, and a switch that keeps the coordinates.

describe('BodyPicker', () => {
  it('lists the observers of /meta with translated names and keeps lat/lon/elev on a switch', () => {
    const store = createSkyStore({ body: 'earth', lat: 48.8566, lon: 2.3522, elev: 35 });
    store.getState().actions.setMeta(makeMeta());
    render(<BodyPicker store={store} />);
    const select = screen.getByRole('combobox', { name: 'Observed from' });
    expect(select).toHaveValue('earth');
    const labels = screen.getAllByRole('option').map((option) => option.textContent);
    expect(labels).toEqual([
      'Earth',
      'Moon',
      'Mercury',
      'Venus',
      'Mars',
      'Jupiter',
      'Saturn',
      'Uranus',
      'Neptune',
      'Pluto',
    ]);
    expect(screen.getByText('Geodetic latitude (WGS84)')).toBeInTheDocument();
    expect(screen.getByTestId('observer-coverage')).toHaveTextContent(
      i18next.t('observer.coverage', { start: '1849', end: '2150' }),
    );

    fireEvent.change(select, { target: { value: 'mars' } });
    expect(store.getState().observer).toEqual({
      body: 'mars',
      lat: 48.8566,
      lon: 2.3522,
      elev: 35,
    });
    expect(screen.getByText('Planetocentric latitude')).toBeInTheDocument();
  });

  it('shows the approximation note of Pluto and none for Mars', () => {
    const store = createSkyStore({ body: 'mars' });
    store.getState().actions.setMeta(makeMeta());
    render(<BodyPicker store={store} />);
    expect(screen.queryByText(i18next.t('warnings.pluto_barycenter'))).toBeNull();
    act(() => {
      store.getState().actions.setObserver({ body: 'pluto', lat: 0, lon: 0, elev: 0 });
    });
    expect(screen.getByText(i18next.t('warnings.pluto_barycenter'))).toBeInTheDocument();
  });

  it('offers the current body alone before /meta, raw when it is unknown', () => {
    const store = createSkyStore({ body: 'moon' });
    const view = render(<BodyPicker store={store} />);
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Moon']);
    expect(screen.queryByTestId('observer-coverage')).toBeNull();
    view.unmount();

    const odd = createSkyStore({ body: 'vulcan' });
    render(<BodyPicker store={odd} />);
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['vulcan']);
  });
});

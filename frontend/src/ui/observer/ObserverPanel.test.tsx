import { render, screen } from '@testing-library/react';

import type { searchPlaces } from '../../api/geocoder';
import { createSkyStore } from '../../state/store';
import { makeMeta } from '../../test/meta';
import ObserverPanel from './ObserverPanel';

// The panel composes its sections: geolocation, body, coordinates, presets and place search.

describe('ObserverPanel', () => {
  it('renders every section from the store', () => {
    const store = createSkyStore({ body: 'mars', lat: 18.41, lon: 77.69, elev: 0 });
    store.getState().actions.setMeta(makeMeta());
    render(
      <ObserverPanel
        store={store}
        geolocation={{ geolocation: null, isSecureContext: true }}
        geocode={vi.fn<typeof searchPlaces>()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Use my location' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Observed from' })).toHaveValue('mars');
    expect(screen.getByRole('textbox', { name: 'Latitude' })).toHaveValue('18.41');
    expect(screen.getByRole('button', { name: /Jezero/ })).toBeInTheDocument();
    expect(
      screen.getByRole('switch', { name: 'Online place search (Nominatim)' }),
    ).toBeInTheDocument();
  });

  it('renders without /meta and without injected dependencies', () => {
    const store = createSkyStore();
    render(<ObserverPanel store={store} />);
    expect(screen.getByRole('combobox', { name: 'Observed from' })).toHaveValue('earth');
    expect(screen.queryByRole('switch')).toBeNull();
  });
});

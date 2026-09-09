import { act, fireEvent, render, screen } from '@testing-library/react';
import i18next from 'i18next';

import { createSkyStore } from '../../state/store';
import PresetList from './PresetList';

// The presets: none on Earth, the current body's sites as buttons writing the observer.

describe('PresetList', () => {
  it('renders nothing on Earth and the Moon sites on the Moon', () => {
    const store = createSkyStore({ body: 'earth' });
    render(<PresetList store={store} />);
    expect(screen.queryByRole('button')).toBeNull();
    act(() => {
      store.getState().actions.setObserver({ body: 'moon', lat: 0, lon: 0, elev: 0 });
    });
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent(i18next.t('presets.title'));
    expect(screen.getByText(i18next.t('presets.note'))).toBeInTheDocument();
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual([
      'Tranquility Base (Statio Tranquillitatis)0.67°, 23.47°',
      'Tycho crater-43.3°, -11.22°',
      'Shackleton crater-89.67°, 129.78°',
    ]);
  });

  it('writes the four observer fields on a click', () => {
    const store = createSkyStore({ body: 'mars', lat: 1, lon: 2, elev: 300 });
    render(<PresetList store={store} />);
    fireEvent.click(screen.getByRole('button', { name: /Jezero/ }));
    expect(store.getState().observer).toEqual({ body: 'mars', lat: 18.41, lon: 77.69, elev: 0 });
    fireEvent.click(screen.getByRole('button', { name: /Olympus Mons/ }));
    expect(store.getState().observer).toEqual({ body: 'mars', lat: 18.4, lon: -134, elev: 0 });
  });
});

import { act, fireEvent, render, screen } from '@testing-library/react';
import i18next from 'i18next';

import { createSkyStore } from '../../state/store';
import type { SkyStore } from '../../state/storeTypes';
import { DSO_TYPES } from '../../state/types';
import { fakeMeta } from '../../test/fakeBundle';
import LayersPanel, { MANUAL_MAGLIM_DEFAULT } from './LayersPanel';

function storeWith(
  options: { minor?: boolean; dso?: boolean; constellations?: boolean } = {},
): SkyStore {
  const store = createSkyStore();
  const { actions } = store.getState();
  actions.setMeta(
    fakeMeta({
      minor: options.minor ?? true,
      ...(options.dso === undefined ? {} : { dso: options.dso }),
      ...(options.constellations === undefined ? {} : { constellations: options.constellations }),
    }),
  );
  actions.setCatalogStatus('dso', options.dso === false ? 'missing' : 'ready');
  actions.setCatalogStatus(
    'constellations',
    options.constellations === false ? 'missing' : 'ready',
  );
  return store;
}

describe('LayersPanel', () => {
  it('offers one switch per layer and writes the store', () => {
    const store = storeWith();
    render(<LayersPanel store={store} />);
    const stars = screen.getByRole('switch', { name: 'Stars' });
    expect(stars).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(stars);
    expect(store.getState().layers.stars).toBe(false);
    const minor = screen.getByRole('switch', { name: 'Asteroids and comets' });
    expect(minor).toBeEnabled();
    fireEvent.click(minor);
    expect(store.getState().layers.minor).toBe(true);
    expect(screen.getAllByRole('switch')).toHaveLength(12 + 3);
  });

  it('disables the layers whose data is missing, with a readable reason', () => {
    const store = storeWith({ minor: false, dso: false, constellations: false });
    render(<LayersPanel store={store} />);
    const dso = screen.getByRole('switch', { name: 'Deep-sky objects' });
    expect(dso).toBeDisabled();
    expect(dso).toHaveAccessibleDescription('Deep-sky data is missing on this server.');
    for (const name of ['Constellation lines', 'Constellation names', 'Constellation boundaries']) {
      const control = screen.getByRole('switch', { name });
      expect(control).toBeDisabled();
      expect(control).toHaveAccessibleDescription('Constellation data is missing on this server.');
    }
    const minor = screen.getByRole('switch', { name: 'Asteroids and comets' });
    expect(minor).toBeDisabled();
    expect(minor).toHaveAccessibleDescription('Minor-body data is missing on this server.');
    expect(screen.getByRole('switch', { name: 'Stars' })).toBeEnabled();
    for (const box of screen.getAllByRole('checkbox')) {
      expect(box).toBeDisabled();
    }
  });

  it('waits for /meta before saying anything about the minor bodies', () => {
    const store = createSkyStore();
    render(<LayersPanel store={store} />);
    const minor = screen.getByRole('switch', { name: 'Asteroids and comets' });
    expect(minor).toBeDisabled();
    expect(minor).not.toHaveAttribute('aria-describedby');
    expect(screen.queryByText('Minor-body data is missing on this server.')).toBeNull();
    expect(screen.getByRole('switch', { name: 'Stars' })).toBeEnabled();
  });

  it('shows the minor-body section with "show more" and the pinned list when the layer is on', () => {
    const store = storeWith();
    const { actions } = store.getState();
    render(<LayersPanel store={store} />);
    expect(screen.queryByRole('button', { name: 'Show every default minor body' })).toBeNull();
    act(() => {
      actions.setLayer('minor', true);
    });
    const more = screen.getByRole('button', { name: 'Show every default minor body' });
    expect(more).toBeDisabled();
    expect(screen.getByText(/No pinned minor body/)).toBeInTheDocument();
    act(() => {
      actions.setMinorDefaults(
        [
          {
            id: 'a:1',
            designation: '(1) Ceres',
            name: 'Ceres',
            kind: 'asteroid',
            elements_epoch_tt: 2461200.5,
          },
          {
            id: 'a:4',
            designation: '(4) Vesta',
            name: 'Vesta',
            kind: 'asteroid',
            elements_epoch_tt: 2461200.5,
          },
        ],
        'ready',
      );
      actions.setMinor(['a:4', 'c:1P']);
    });
    // Two defaults, twenty shown by default: nothing more to show.
    expect(more).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Unpin Vesta' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Unpin c:1P' }));
    expect(store.getState().minor).toEqual(['a:4']);
  });

  it('shows the coverage warnings of the stars and of the minor bodies beside their layer (TIME-4)', () => {
    const store = storeWith();
    const { actions } = store.getState();
    render(<LayersPanel store={store} />);
    act(() => {
      actions.setFrames({
        warnings: [
          { code: 'proper_motion_extrapolated', params: { years: 10000 } },
          { code: 'delta_t_approximate', rangeTt: [2441317.5, 2461349.5] },
        ],
        minor: [
          {
            id: 'a:1',
            kind: 'asteroid',
            elementsEpochTt: 2460200.5,
            extrapolationYears: 30,
            warnings: [
              { code: 'mpc_extrapolation', params: { years: 30 }, rangeTt: [2441317.5, 2461349.5] },
            ],
            drawn: true,
          },
        ],
      });
    });
    const stars = i18next.t('warnings.proper_motion_extrapolated', { years: 10000 });
    const minor = `${i18next.t('warnings.mpc_extrapolation', { years: 30 })} (a:1)`;
    const range = i18next.t('warnings.validRange', { start: '1972', end: '2026' });
    expect(screen.getByText(stars)).toBeInTheDocument();
    // The time warning belongs to the readout and the time panel, not here.
    expect(screen.queryByText(i18next.t('warnings.delta_t_approximate'))).toBeNull();
    // The minor-body warnings appear with their section, once the layer is on.
    expect(screen.queryByText(minor)).toBeNull();
    act(() => {
      actions.setLayer('minor', true);
    });
    expect(screen.getByText(minor)).toBeInTheDocument();
    expect(screen.getByText(range)).toBeVisible();
    expect(screen.getAllByTestId('coverage-badges')).toHaveLength(2);
  });

  it('switches the magnitude limit between automatic and a manual slider', () => {
    const store = storeWith();
    render(<LayersPanel store={store} />);
    expect(screen.getByText(/Automatic: the limit follows/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: 'Set the magnitude limit by hand' }));
    expect(store.getState().options.maglim).toBe(MANUAL_MAGLIM_DEFAULT);
    const slider = screen.getByRole('slider', { name: 'Faintest magnitude' });
    expect(slider).toHaveAttribute('aria-valuetext', '6.5');
    fireEvent.change(slider, { target: { value: '8.2' } });
    expect(store.getState().options.maglim).toBeCloseTo(8.2, 9);
    fireEvent.click(screen.getByRole('switch', { name: 'Set the magnitude limit by hand' }));
    expect(store.getState().options.maglim).toBeNull();
  });

  it('filters the deep-sky types: every type is null, a subset is a canonical list', () => {
    const store = storeWith();
    render(<LayersPanel store={store} />);
    const galaxy = screen.getByRole('checkbox', { name: 'Galaxy' });
    expect(galaxy).toBeChecked();
    fireEvent.click(galaxy);
    expect(store.getState().dsoTypes).toEqual(DSO_TYPES.filter((type) => type !== 'galaxy'));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Nebula' }));
    expect(store.getState().dsoTypes).toEqual(
      DSO_TYPES.filter((type) => type !== 'galaxy' && type !== 'nebula'),
    );
    fireEvent.click(galaxy);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Nebula' }));
    expect(store.getState().dsoTypes).toBeNull();
  });

  it('sets the ground, the atmosphere and the refraction, disabled off Earth with a reason', () => {
    const store = storeWith();
    const { actions } = store.getState();
    render(<LayersPanel store={store} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Ground' }), {
      target: { value: 'off' },
    });
    expect(store.getState().options.ground).toBe('off');
    const atmosphere = screen.getByRole('switch', { name: 'Atmosphere and daylight' });
    fireEvent.click(atmosphere);
    expect(store.getState().options.atm).toBe(false);
    act(() => {
      actions.setObserver({ body: 'mars', lat: 18.41, lon: 77.69, elev: 0 });
    });
    expect(atmosphere).toBeDisabled();
    expect(atmosphere).toHaveAccessibleDescription('Available for an observer on Earth only.');
    expect(screen.getByRole('switch', { name: 'Atmospheric refraction' })).toBeDisabled();
  });

  it('sets the label density and lists the visible objects', () => {
    const store = storeWith();
    render(<LayersPanel store={store} />);
    const slider = screen.getByRole('slider', { name: 'Label density' });
    expect(slider).toHaveAttribute('aria-valuetext', 'Normal');
    fireEvent.change(slider, { target: { value: '3' } });
    expect(store.getState().options.labels).toBe(3);
    expect(slider).toHaveAttribute('aria-valuetext', 'All');
    expect(screen.getByRole('heading', { level: 4 })).toHaveTextContent('No object is labelled');
  });
});

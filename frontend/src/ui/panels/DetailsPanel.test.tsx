import { act, fireEvent, render, screen } from '@testing-library/react';
import i18next from 'i18next';

import type { AltAzEntry } from '../../api/client';
import { createSkyStore } from '../../state/store';
import type { SkyStore } from '../../state/storeTypes';
import { createSelectionReadout } from '../../state/types';
import { fakeBundle, fakeMeta } from '../../test/fakeBundle';
import DetailsPanel from './DetailsPanel';

const T0 = 1_757_000_000_000;
const TT = 2460409.25;

function entry(id: string, extra: Partial<AltAzEntry> = {}): AltAzEntry {
  return {
    id,
    alt_deg: 21.6312487,
    az_deg: 185.8113516,
    ra_icrs_deg: 101.2824638,
    dec_icrs_deg: -16.7279056,
    ra_date_deg: 101.5522393,
    dec_date_deg: -16.7519949,
    mag: -1.44,
    constellation: 'CMa',
    ...extra,
  };
}

function storeWith(selection: string | null): SkyStore {
  const store = createSkyStore({ t: TT, ...(selection === null ? {} : { sel: selection }) }, T0);
  const { actions } = store.getState();
  actions.setMeta(fakeMeta({ minor: true }));
  actions.setBundle(fakeBundle());
  return store;
}

/** The `dd` next to a `dt` label. */
function valueOf(label: string): string {
  const dt = screen.getByText(label, { selector: 'dt' });
  const dd = dt.nextElementSibling;
  if (dd === null) {
    throw new Error(`no value for ${label}`);
  }
  return dd.textContent;
}

describe('DetailsPanel', () => {
  afterEach(async () => {
    await i18next.changeLanguage('en');
  });

  it('invites to select something while nothing is selected', () => {
    render(<DetailsPanel store={storeWith(null)} />);
    expect(screen.getByText(/Nothing selected/)).toBeInTheDocument();
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('names a star with its designations, type and constellation, and shows the server values', () => {
    const store = storeWith('hip:32349');
    render(<DetailsPanel store={store} />);
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('Sirius');
    expect(screen.getByText('α CMa · 9 CMa · HIP 32349')).toBeInTheDocument();
    expect(valueOf('Type')).toBe('Star');
    // Before any answer: the constellation is unknown to the panel (the controller fills it).
    expect(valueOf('Constellation')).toBe('—');
    expect(valueOf('Right ascension (ICRS)')).toBe('—');

    act(() => {
      store.getState().actions.setDetails({
        id: 'hip:32349',
        status: 'ready',
        entry: entry('hip:32349'),
        tt: TT,
        refraction: true,
        con: 'CMa',
        error: null,
      });
    });
    expect(valueOf('Constellation')).toBe('Canis Major (Canis Majoris)');
    expect(valueOf('Altitude')).toBe('21.63°');
    expect(valueOf('Azimuth')).toBe('185.81°');
    expect(valueOf('Right ascension (ICRS)')).toBe('06h 45m 07.8s');
    expect(valueOf('Declination (ICRS)')).toBe('-16° 43′ 40″');
    expect(valueOf('Right ascension (of date)')).toBe('06h 46m 12.5s');
    expect(valueOf('Declination (of date)')).toBe('-16° 45′ 07″');
    expect(valueOf('Magnitude')).toBe('-1.4');
    // A star has no distance, phase or size row.
    expect(screen.queryByText('Distance', { selector: 'dt' })).toBeNull();
    expect(screen.queryByText('Illuminated fraction', { selector: 'dt' })).toBeNull();
    expect(screen.getByText(/Server values at 2024-04-08 17:58:51 UTC/)).toBeInTheDocument();
  });

  it('prefers the engine readout for the horizontal channels and keeps RA/Dec authoritative', () => {
    const store = storeWith('hip:32349');
    render(<DetailsPanel store={store} />);
    act(() => {
      store.getState().actions.setDetails({
        id: 'hip:32349',
        status: 'ready',
        entry: entry('hip:32349'),
        tt: TT,
        con: 'CMa',
      });
      store.getState().actions.publishReadout({
        ...createSelectionReadout(),
        id: 'hip:32349',
        valid: true,
        alt: 30.5,
        az: 190.25,
        mag: -1.5,
      });
    });
    expect(valueOf('Altitude')).toBe('30.50°');
    expect(valueOf('Azimuth')).toBe('190.25°');
    expect(valueOf('Magnitude')).toBe('-1.5');
    expect(valueOf('Right ascension (ICRS)')).toBe('06h 45m 07.8s');
    // A readout of another object is ignored.
    act(() => {
      store.getState().actions.publishReadout({
        ...createSelectionReadout(),
        id: 'mars',
        valid: true,
        alt: 5,
        az: 5,
      });
    });
    expect(valueOf('Altitude')).toBe('21.63°');
  });

  it('shows the Moon in kilometres with its phase and angular size', () => {
    const store = storeWith('moon');
    render(<DetailsPanel store={store} />);
    act(() => {
      store.getState().actions.setDetails({
        id: 'moon',
        status: 'ready',
        entry: entry('moon', {
          dist_au: 0.002400662,
          mag: -4.14,
          phase: 0.0000949,
          diam_deg: 0.5543674,
          constellation: 'Psc',
        }),
        tt: TT,
        con: 'Psc',
      });
    });
    const heading = screen.getByRole('heading', { level: 3 }).textContent;
    expect(heading === 'Moon' || heading === 'moon').toBe(true);
    expect(valueOf('Type')).toBe('Moon');
    expect(valueOf('Distance')).toMatch(/^359,\d{3} km$/);
    expect(valueOf('Illuminated fraction')).toBe('0%');
    expect(valueOf('Angular size')).toBe('33.3′');
    // Pisces is not in the fake constellations: the translated name alone.
    expect(valueOf('Constellation')).toBe('Pisces');
  });

  it('names a deep-sky object with its Messier and NGC designations and its type', () => {
    const store = storeWith('dso:M31');
    render(<DetailsPanel store={store} />);
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('Andromeda Galaxy');
    expect(screen.getByText('M 31 · NGC 224')).toBeInTheDocument();
    expect(valueOf('Type')).toBe('Galaxy');
    act(() => {
      store.getState().actions.setDetails({ id: 'dso:M31', status: 'loading', con: 'And' });
    });
    expect(valueOf('Constellation')).toBe('Andromeda (Andromedae)');
    expect(screen.getByText('Fetching the authoritative position…')).toBeInTheDocument();
  });

  it('names a minor body from the frame status with its elements epoch and extrapolation', () => {
    const store = storeWith('a:1');
    render(<DetailsPanel store={store} />);
    act(() => {
      store.getState().actions.setFrames({
        minor: [
          {
            id: 'a:1',
            name: 'Ceres',
            kind: 'asteroid',
            elementsEpochTt: 2461200.5,
            extrapolationYears: 2.5,
            warnings: [],
            drawn: true,
          },
        ],
      });
    });
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('Ceres');
    expect(valueOf('Type')).toBe('Asteroid');
    // 2461200.5 TT is 2026-06-09 00:00 TT, a minute before midnight in UTC.
    expect(valueOf('Elements epoch')).toBe('2026-06-08');
    expect(screen.getByText('Orbital elements extrapolated over 2.5 years')).toBeInTheDocument();
    // A comet id without any list falls back to the id and the comet kind.
    act(() => {
      store.getState().actions.select('c:1P');
    });
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('c:1P');
    expect(valueOf('Type')).toBe('Comet');
  });

  it('shows the contract messages for a refused, out-of-range, missing or unreachable answer', () => {
    const store = storeWith('hip:32349');
    const { actions } = store.getState();
    render(<DetailsPanel store={store} />);
    act(() => {
      actions.setDetails({
        id: 'hip:32349',
        status: 'error',
        error: { status: 422, slug: 'outside-coverage', rangeTt: [2396758.5, 2506000.5] },
      });
    });
    expect(
      screen.getByText('Outside the data coverage: valid from 1850 to 2149.'),
    ).toBeInTheDocument();
    act(() => {
      actions.setDetails({ error: { status: 400, slug: 'invalid-parameter' } });
    });
    expect(screen.getByText(/refused this selection/)).toBeInTheDocument();
    act(() => {
      actions.setDetails({ error: { status: 503, slug: 'data-not-ready' } });
    });
    expect(screen.getByText(/missing on this server/)).toBeInTheDocument();
    act(() => {
      actions.setDetails({ error: { status: 0, slug: 'unknown' } });
    });
    expect(screen.getByText(/could not be fetched/)).toBeInTheDocument();
  });

  it('centres the view and toggles follow mode', () => {
    const store = storeWith('hip:32349');
    render(<DetailsPanel store={store} />);
    fireEvent.click(screen.getByRole('button', { name: 'Centre the view' }));
    expect(store.getState().centreRequest).toMatchObject({ id: 'hip:32349' });
    const follow = screen.getByRole('switch', { name: 'Follow' });
    expect(follow).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(follow);
    expect(store.getState().follow).toBe(true);
    expect(follow).toHaveAttribute('aria-checked', 'true');
  });

  it('translates the constellation and the labels in French', async () => {
    await i18next.changeLanguage('fr');
    const store = storeWith('hip:32349');
    render(<DetailsPanel store={store} />);
    act(() => {
      store.getState().actions.setDetails({
        id: 'hip:32349',
        status: 'ready',
        entry: entry('hip:32349'),
        tt: TT,
        con: 'CMa',
      });
    });
    expect(valueOf('Constellation')).toBe('Grand Chien (Canis Major, Canis Majoris)');
    expect(valueOf('Hauteur')).toBe('21,63°');
    expect(valueOf('Type')).toBe('Étoile');
  });
});

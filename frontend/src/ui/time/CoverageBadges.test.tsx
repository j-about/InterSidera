import { act, render, screen } from '@testing-library/react';
import i18next from 'i18next';

import { createSkyStore } from '../../state/store';
import { EPHEMERIS_TT } from '../../test/meta';
import CoverageBadges from './CoverageBadges';

// The badges: nothing without warnings, one badge per code with its text and its visible range
// line, the minor-body objects, the snapshot badge, no banner of its own at a bound stop (the
// shell's `Banners` announces it once), and the target filter.

const T0 = 1_757_000_000_000;

describe('CoverageBadges', () => {
  it('renders nothing while the window carries no warning', () => {
    const store = createSkyStore();
    const { container } = render(<CoverageBadges store={store} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the warnings and the snapshot badge, and leaves the bound stop to the shell', () => {
    const store = createSkyStore({ t: EPHEMERIS_TT[1] - 1, speed: 3600 }, T0);
    render(<CoverageBadges store={store} />);
    act(() => {
      store.getState().actions.setFrames({
        snapshot: true,
        warnings: [
          { code: 'delta_t_approximate', rangeTt: [2441317.5, 2461349.5] },
          { code: 'proper_motion_extrapolated', params: { years: 10000 } },
        ],
        minor: [
          {
            id: 'a:1',
            kind: 'asteroid',
            elementsEpochTt: 2460200.5,
            extrapolationYears: 60,
            warnings: [{ code: 'mpc_unreliable', params: { years: 60 } }],
            drawn: false,
          },
        ],
      });
    });
    const range = i18next.t('warnings.validRange', { start: '1972', end: '2026' });
    const items = screen.getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([
      i18next.t('time.snapshot'),
      // The valid range is visible text under the badge, not a tooltip (unreachable on touch).
      `${i18next.t('warnings.delta_t_approximate')}${range}`,
      i18next.t('warnings.proper_motion_extrapolated', { years: 10000 }),
      `${i18next.t('warnings.mpc_unreliable', { years: 60 })} (a:1)`,
    ]);
    expect(screen.getByText(range)).toBeVisible();
    expect(
      screen.getByText(i18next.t('warnings.delta_t_approximate')).closest('span'),
    ).not.toHaveAttribute('title');
    expect(screen.queryByRole('status')).toBeNull();

    act(() => {
      store.getState().actions.stopAtBound(EPHEMERIS_TT, T0 + 100_000);
    });
    expect(store.getState().frames.coverageStop).not.toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
  });

  it('filters by target', () => {
    const store = createSkyStore();
    act(() => {
      store.getState().actions.setFrames({
        warnings: [{ code: 'delta_t_approximate' }, { code: 'pluto_barycenter' }],
      });
    });
    render(<CoverageBadges store={store} targets={['observer']} />);
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      i18next.t('warnings.pluto_barycenter'),
    ]);
  });
});

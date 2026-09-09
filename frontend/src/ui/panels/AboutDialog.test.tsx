import { act, fireEvent, render, screen, within } from '@testing-library/react';

import { CREDITS, isCreditEntry, parseCredits } from '../../data/credits';
import { REPOSITORY_URL } from '../../data/repository';
import { createSkyStore } from '../../state/store';
import { fakeMeta } from '../../test/fakeBundle';
import AboutDialog from './AboutDialog';

describe('credits.json', () => {
  it('is a validated list with every registry field on every entry', () => {
    expect(CREDITS.length).toBeGreaterThanOrEqual(15);
    const keys = CREDITS.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of [
      'hyg',
      'ngc',
      'stellarium_modern',
      'd3_bounds',
      'mpcorb',
      'nominatim',
      'lucide',
    ]) {
      expect(keys).toContain(key);
    }
    expect(CREDITS.every(isCreditEntry)).toBe(true);
    expect(() => parseCredits([{ key: 'x' }])).toThrow(/entry 0/);
    expect(() => parseCredits({})).toThrow(/not an array/);
  });
});

describe('AboutDialog', () => {
  it('stays closed until the store opens it, then shows versions, the repository and the credits', () => {
    const store = createSkyStore();
    const { actions } = store.getState();
    actions.setMeta(fakeMeta({ minor: true }));
    actions.setHealth({ status: 'ready', version: '0.9.7' });
    render(<AboutDialog store={store} />);
    expect(screen.queryByRole('dialog')).toBeNull();

    act(() => {
      actions.openDialog('about');
    });
    const dialog = screen.getByRole('dialog', { name: 'About InterSidera' });
    expect(dialog).toHaveAttribute('open');
    expect(within(dialog).getByText(__APP_VERSION__)).toBeInTheDocument();
    expect(within(dialog).getByText('0.9.7')).toBeInTheDocument();
    expect(within(dialog).getByText('1.1.0')).toBeInTheDocument();

    const repository = within(dialog).getByRole('link', { name: /Source code repository/ });
    expect(repository).toHaveAttribute('href', REPOSITORY_URL);
    expect(repository).toHaveAttribute('target', '_blank');
    expect(repository).toHaveAttribute('rel', 'noopener noreferrer');
    expect(repository).toHaveTextContent('opens in a new tab');

    // What this server serves: the runtime attributions of /meta.
    const meta = fakeMeta({ minor: true });
    expect(within(dialog).getByText(meta.catalogs.stars.attribution)).toBeInTheDocument();
    // The OpenNGC attribution also appears on its two registry cards below.
    expect(within(dialog).getAllByText('OpenNGC, Mattia Verga, CC BY-SA 4.0').length).toBe(3);
    // The MPC attribution also appears on the MPCORB and comets cards below.
    expect(within(dialog).getAllByText('Orbital elements: IAU Minor Planet Center').length).toBe(3);
    // The geocoder attribution of /meta also matches the Nominatim registry card.
    expect(within(dialog).getAllByText(meta.geocoder.attribution).length).toBeGreaterThan(0);

    // Every registry entry renders with its license and attribution; the license text folds.
    const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const entry of CREDITS) {
      const title = entry.filename ?? entry.key;
      const heading = within(dialog).getByRole('heading', {
        level: 4,
        name: new RegExp(`^${escape(title)}`),
      });
      const card = heading.closest('article');
      if (card === null) {
        throw new Error(`no card for ${entry.key}`);
      }
      if (entry.license !== null) {
        expect(within(card).getAllByText(entry.license).length).toBeGreaterThan(0);
      }
      if (entry.attribution !== null) {
        expect(within(card).getAllByText(entry.attribution).length).toBeGreaterThan(0);
      }
      if (entry.url !== null) {
        expect(
          within(card).getByRole('link', {
            name: new RegExp(escape(entry.url)),
          }),
        ).toHaveAttribute('rel', 'noopener noreferrer');
      }
      expect(within(card).queryByText('License text') !== null).toBe(entry.license_text !== null);
    }
    expect(within(dialog).getAllByText(/CC BY-SA 4\.0/).length).toBeGreaterThan(0);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(store.getState().ui.dialog).toBeNull();
    expect(dialog).not.toHaveAttribute('open');
  });

  it('renders without /meta or /health (nothing served yet)', () => {
    const store = createSkyStore();
    store.getState().actions.openDialog('about');
    render(<AboutDialog store={store} />);
    const dialog = screen.getByRole('dialog', { name: 'About InterSidera' });
    expect(within(dialog).queryByText('Data served by this sky service')).toBeNull();
    expect(within(dialog).getByText('Data credits and licenses')).toBeInTheDocument();
  });
});

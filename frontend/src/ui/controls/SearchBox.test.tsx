import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { MinorBodySummary } from '../../api/client';
import { createSkyStore } from '../../state/store';
import type { SkyStore } from '../../state/storeTypes';
import { fakeBundle, fakeMeta } from '../../test/fakeBundle';
import SearchBox from './SearchBox';

const T0 = 1_757_000_000_000;

function storeWith(options: { minor?: boolean | null } = {}): SkyStore {
  const store = createSkyStore({ t: 2460409.25 }, T0);
  const { actions } = store.getState();
  if (options.minor !== null) {
    actions.setMeta(fakeMeta({ minor: options.minor ?? false }));
  }
  actions.setBundle(fakeBundle());
  return store;
}

function combobox(): HTMLElement {
  return screen.getByRole('combobox', { name: 'Search the sky' });
}

function type(text: string): void {
  fireEvent.change(combobox(), { target: { value: text } });
}

function optionNames(): string[] {
  return screen.getAllByRole('option').map((option) => option.textContent);
}

describe('SearchBox', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is a combobox with the ARIA it needs, controlling an (initially closed) listbox', () => {
    render(<SearchBox store={storeWith()} />);
    const input = combobox();
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(input).toHaveAttribute('aria-autocomplete', 'list');
    const controls = input.getAttribute('aria-controls');
    expect(controls).toBeTruthy();
    const list = document.getElementById(controls ?? '');
    expect(list).not.toBeNull();
    expect(list).toHaveAttribute('role', 'listbox');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('lists local hits as options and selects the highlighted one with the keyboard', () => {
    const store = storeWith();
    render(<SearchBox store={store} />);
    type('Betelg');
    expect(combobox()).toHaveAttribute('aria-expanded', 'true');
    const options = screen.getAllByRole('option');
    expect(options[0]).toHaveTextContent('Betelgeuse');
    expect(options[0]).toHaveTextContent('α Ori · 58 Ori · HIP 27989');
    expect(options[0]).toHaveTextContent('Star');
    expect(options[0]).toHaveAttribute('aria-selected', 'false');
    fireEvent.keyDown(combobox(), { key: 'ArrowDown' });
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(combobox()).toHaveAttribute('aria-activedescendant', options[0]?.id);
    fireEvent.keyDown(combobox(), { key: 'Enter' });
    const s = store.getState();
    expect(s.selection).toBe('hip:27989');
    expect(s.centreRequest?.id).toBe('hip:27989');
    expect(s.ui.panel).toBe('details');
    expect(combobox()).toHaveAttribute('aria-expanded', 'false');
    expect(combobox()).toHaveValue('Betelgeuse');
  });

  it('takes the first option on Enter without a highlight, and M31 is the canonical id', () => {
    const store = storeWith();
    render(<SearchBox store={store} />);
    type('M31');
    expect(optionNames()[0]).toContain('Andromeda Galaxy');
    fireEvent.keyDown(combobox(), { key: 'Enter' });
    expect(store.getState().selection).toBe('dso:NGC224');
  });

  it('centres on a constellation without selecting it', () => {
    const store = storeWith();
    store.getState().actions.select('hip:32349');
    render(<SearchBox store={store} />);
    type('orion');
    expect(optionNames()[0]).toContain('Orion');
    expect(optionNames()[0]).toContain('Constellation');
    fireEvent.keyDown(combobox(), { key: 'Enter' });
    expect(store.getState().centreRequest?.id).toBe('con:Ori');
    expect(store.getState().selection).toBe('hip:32349');
  });

  it('chooses an option on pointer down and moves the highlight with the arrows', () => {
    const store = storeWith();
    render(<SearchBox store={store} />);
    type('ori');
    fireEvent.keyDown(combobox(), { key: 'ArrowDown' });
    fireEvent.keyDown(combobox(), { key: 'ArrowDown' });
    const options = screen.getAllByRole('option');
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(combobox(), { key: 'ArrowUp' });
    fireEvent.keyDown(combobox(), { key: 'ArrowUp' });
    expect(combobox()).not.toHaveAttribute('aria-activedescendant');
    const rigel = screen.getByRole('option', { name: /Rigel/ });
    fireEvent.mouseDown(rigel);
    expect(store.getState().selection).toBe('hip:24436');
  });

  it('closes on Escape, then clears the text, and closes on blur', () => {
    render(<SearchBox store={storeWith()} />);
    type('sirius');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.keyDown(combobox(), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(combobox()).toHaveValue('sirius');
    fireEvent.keyDown(combobox(), { key: 'Escape' });
    expect(combobox()).toHaveValue('');
    type('sirius');
    fireEvent.focus(combobox());
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.blur(combobox(), { relatedTarget: document.body });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('tells when nothing matches and when the minor-body search is unavailable', () => {
    render(<SearchBox store={storeWith({ minor: false })} />);
    type('zz');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(
      screen.getByText('Minor-body search is unavailable on this server.'),
    ).toBeInTheDocument();
    // One character: too short for the minor bodies, and nothing local contains a "q".
    type('q');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText('No match.')).toBeInTheDocument();
    expect(screen.queryByText(/Minor-body search/)).toBeNull();
  });

  it('says nothing about the minor bodies before /meta answers', () => {
    render(<SearchBox store={storeWith({ minor: null })} />);
    type('ce');
    expect(screen.getByText('No match.')).toBeInTheDocument();
    expect(screen.queryByText(/[Mm]inor/)).toBeNull();
  });

  it('searches the minor bodies after the debounce, pins and selects the chosen one', async () => {
    const rows: MinorBodySummary[] = [
      {
        id: 'a:1',
        designation: '(1) Ceres',
        name: 'Ceres',
        kind: 'asteroid',
        h_mag: 3.34,
        elements_epoch_tt: 2461200.5,
      },
    ];
    const fetchMock = vi.fn<typeof fetch>((input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      expect(url).toContain('/api/v1/minor-bodies/search?');
      expect(url).toContain('limit=8');
      expect(url).toMatch(/q=cere/i);
      return Promise.resolve(
        new Response(JSON.stringify(rows), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const store = storeWith({ minor: true });
    render(<SearchBox store={store} />);
    type('cere');
    expect(screen.getByText('Searching the minor bodies…')).toBeInTheDocument();
    const ceres = await screen.findByRole('option', { name: /Ceres/ }, { timeout: 3000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ceres).toHaveTextContent('Asteroid');
    expect(store.getState().layers.minor).toBe(false);
    fireEvent.mouseDown(ceres);
    const s = store.getState();
    expect(s.minor).toEqual(['a:1']);
    expect(s.selection).toBe('a:1');
    expect(s.centreRequest?.id).toBe('a:1');
    expect(s.layers.minor).toBe(true);
    expect(combobox()).toHaveValue('Ceres');
    expect(combobox()).toHaveAttribute('aria-expanded', 'false');
    // Re-focusing asks the minor bodies for the label (never searched before) instead of
    // reporting "no match" for a query that was never sent.
    fireEvent.focus(combobox());
    expect(screen.queryByText('No matching minor body.')).toBeNull();
    expect(screen.getByText('Searching the minor bodies…')).toBeInTheDocument();
    await screen.findByRole('option', { name: /Ceres/ }, { timeout: 3000 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('toasts when the pin cap refuses a minor body', async () => {
    const rows: MinorBodySummary[] = [
      { id: 'c:1P', designation: '1P/Halley', kind: 'comet', elements_epoch_tt: 2450000.5 },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(() =>
        Promise.resolve(
          new Response(JSON.stringify(rows), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      ),
    );
    const store = storeWith({ minor: true });
    const meta = fakeMeta({ minor: true });
    meta.limits.max_minor_bodies = 1;
    store.getState().actions.setMeta(meta);
    store.getState().actions.setMinor(['a:1']);
    render(<SearchBox store={store} />);
    type('halley');
    const halley = await screen.findByRole('option', { name: /Halley/ }, { timeout: 3000 });
    expect(halley).toHaveTextContent('Comet');
    fireEvent.mouseDown(halley);
    await waitFor(() => {
      expect(store.getState().ui.toast?.key).toBe('search.minorCapReached');
    });
    expect(store.getState().minor).toEqual(['a:1']);
  });

  it('rebuilds the index for the observer body', () => {
    const store = storeWith();
    render(<SearchBox store={store} />);
    type('earth');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    store.getState().actions.setObserver({ body: 'mars', lat: 0, lon: 0, elev: 0 });
    type('earth ');
    expect(optionNames().some((name) => name.toLowerCase().includes('earth'))).toBe(true);
  });
});

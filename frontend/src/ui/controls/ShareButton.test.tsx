import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { createSkyStore, defaultsUrlState, urlStateOf } from '../../state/store';
import { serializeUrlState } from '../../state/url';
import ShareButton, { shareUrl } from './ShareButton';

const T0 = 1_757_000_000_000;

describe('shareUrl', () => {
  it('builds origin + pathname + the canonical query, never the hash', () => {
    const store = createSkyStore(
      { lat: 48.8566, lon: 2.3522, t: 2460409.25, sel: 'hip:32349', night: true, nightLevel: 0.6 },
      T0,
    );
    const url = shareUrl(store.getState(), {
      origin: 'https://sky.example',
      pathname: '/app/',
    });
    const expected = serializeUrlState(urlStateOf(store.getState()), defaultsUrlState());
    expect(url).toBe(`https://sky.example/app/?${expected}`);
    expect(url).not.toContain('#');
    expect(url).toContain('sel=hip:32349');
    expect(url).toContain('night=0.6');
    expect(url).toContain('lat=48.86');
  });

  it('omits the question mark when every value is a default', () => {
    const store = createSkyStore({}, T0);
    // Live mode, Greenwich, default view: `t=live` and the observer are always written.
    const url = shareUrl(store.getState(), { origin: 'https://sky.example', pathname: '/' });
    expect(url.startsWith('https://sky.example/?')).toBe(true);
  });
});

/** jsdom has no `navigator.clipboard`: install one (or none) for a test, removed afterwards. */
function withClipboard(
  clipboard: { writeText: (text: string) => Promise<void> } | undefined,
): void {
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
}

describe('ShareButton', () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('writes the link to the clipboard and announces it', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    withClipboard({ writeText });
    const store = createSkyStore({ sel: 'hip:32349' }, T0);
    render(<ShareButton store={store} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy a link to this view' }));
    expect(writeText).toHaveBeenCalledTimes(1);
    const written = writeText.mock.calls[0]?.[0] ?? '';
    expect(written).toBe(shareUrl(store.getState()));
    expect(written).not.toContain('#');
    await waitFor(() => {
      expect(store.getState().ui.toast?.key).toBe('share.copied');
    });
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('falls back to a selected read-only field when the clipboard refuses', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(() =>
      Promise.reject(new Error('denied')),
    );
    withClipboard({ writeText });
    const store = createSkyStore({ sel: 'hip:32349' }, T0);
    render(<ShareButton store={store} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy a link to this view' }));
    const field = await screen.findByRole('textbox', { name: 'Shareable link' });
    expect(field).toHaveAttribute('readonly');
    expect(field).toHaveValue(shareUrl(store.getState()));
    expect(field).toHaveFocus();
    expect(store.getState().ui.toast?.key).toBe('share.failed');
  });

  it('falls back at once when there is no clipboard API', () => {
    withClipboard(undefined);
    const store = createSkyStore({}, T0);
    render(<ShareButton store={store} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy a link to this view' }));
    expect(screen.getByRole('textbox', { name: 'Shareable link' })).toBeInTheDocument();
    expect(store.getState().ui.toast?.key).toBe('share.failed');
  });
});

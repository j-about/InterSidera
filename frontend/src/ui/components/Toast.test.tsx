import { act, render, screen } from '@testing-library/react';

import { createSkyStore } from '../../state/store';
import Toast, { TOAST_DURATION_MS } from './Toast';

describe('Toast', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is a permanent, named polite status region that shows the toast text and hides it after 4 s', () => {
    const store = createSkyStore();
    render(<Toast store={store} />);
    const region = screen.getByRole('status', { name: 'Notifications' });
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveTextContent('');

    act(() => {
      store.getState().actions.showToast('share.copied');
    });
    expect(region).toHaveTextContent('Link copied to the clipboard.');
    act(() => {
      vi.advanceTimersByTime(TOAST_DURATION_MS - 1);
    });
    expect(region).toHaveTextContent('Link copied to the clipboard.');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(region).toHaveTextContent('');
    expect(screen.getByRole('status', { name: 'Notifications' })).toBe(region);
  });

  it('restarts the timer for a new toast, the same key included', () => {
    const store = createSkyStore();
    render(<Toast store={store} />);
    const region = screen.getByRole('status', { name: 'Notifications' });
    act(() => {
      store.getState().actions.showToast('details.unknown');
    });
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    act(() => {
      store.getState().actions.showToast('details.unknown');
    });
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(region).toHaveTextContent('unknown to the sky service');
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(region).toHaveTextContent('');
  });

  it('renders every toast key with its text', () => {
    const store = createSkyStore();
    render(<Toast store={store} />);
    const region = screen.getByRole('status', { name: 'Notifications' });
    for (const [key, text] of [
      ['share.failed', 'could not be copied'],
      ['export.failed', 'export failed'],
      ['search.minorCapReached', 'at their limit'],
    ] as const) {
      act(() => {
        store.getState().actions.showToast(key);
      });
      expect(region).toHaveTextContent(text);
    }
  });
});

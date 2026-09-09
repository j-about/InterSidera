import { act, render, screen } from '@testing-library/react';

import { DESKTOP_QUERY, useMediaQuery } from './useMediaQuery';

/** A controllable `matchMedia`: one listener set per query, `set` flips the match and notifies. */
function fakeMatchMedia() {
  const listeners = new Set<() => void>();
  let matches = false;
  const matchMedia = vi.fn((query: string): MediaQueryList => ({
    get matches() {
      return matches;
    },
    media: query,
    onchange: null,
    addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      if (typeof listener === 'function') {
        listeners.add(listener as () => void);
      }
    },
    removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      if (typeof listener === 'function') {
        listeners.delete(listener as () => void);
      }
    },
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
  const set = (value: boolean): void => {
    matches = value;
    for (const listener of listeners) {
      listener();
    }
  };
  return { matchMedia, set, listeners };
}

function Probe() {
  const desktop = useMediaQuery(DESKTOP_QUERY);
  return <p>{desktop ? 'desktop' : 'phone'}</p>;
}

describe('useMediaQuery', () => {
  it('follows the media query and unsubscribes on unmount', () => {
    const { matchMedia, set, listeners } = fakeMatchMedia();
    vi.stubGlobal('matchMedia', matchMedia);
    try {
      const view = render(<Probe />);
      expect(screen.getByText('phone')).toBeInTheDocument();
      expect(matchMedia).toHaveBeenCalledWith('(width >= 48rem)');
      expect(listeners.size).toBe(1);
      act(() => {
        set(true);
      });
      expect(screen.getByText('desktop')).toBeInTheDocument();
      view.unmount();
      expect(listeners.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

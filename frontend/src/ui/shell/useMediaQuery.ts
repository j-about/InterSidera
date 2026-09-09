import { useCallback, useSyncExternalStore } from 'react';

// A media query as React state (VIEW-5): the shell mounts the time readout and the transport
// either in the top bar (desktop) or in the sheet strip (phone), never both, so no id or store
// subscription is duplicated. `useSyncExternalStore` subscribes to the `change` event; the test
// setup stubs `matchMedia` (jsdom has none) to "no match".

/** Tailwind's `md` breakpoint: the side panel from 48 rem up, the bottom sheet below. */
export const DESKTOP_QUERY = '(width >= 48rem)';

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => {
        list.removeEventListener('change', onChange);
      };
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches);
}

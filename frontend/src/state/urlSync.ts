// Store <-> URL synchronisation (plan D79, brief l.552): the impure half of the URL codec.
// Every store change that alters the URL view is written with `history.replaceState` at most
// once per `minIntervalMs` (default 500 ms: <= 2 Hz, within WebKit's 100 calls per 10 s), with a
// trailing write so the last state always lands; `popstate` re-applies the URL to the store
// without echoing it back. Uses only the platform history and timer APIs: no storage (OBS-8).

import type { SkyStore } from './storeTypes';
import { defaultsUrlState, urlStateOf } from './store';
import { parseUrlState, serializeUrlState, urlStatesEqual } from './url';

/** What the synchroniser needs from `window.history` (the real object satisfies it). */
export type UrlHistory = Pick<History, 'replaceState'>;
/** What the synchroniser needs from `window.location`. */
export type UrlLocation = Pick<Location, 'pathname' | 'search' | 'hash'>;
/** What the synchroniser needs from `window` to hear `popstate`. */
export type UrlSyncTarget = Pick<Window, 'addEventListener' | 'removeEventListener'>;

export interface UrlSyncOptions {
  /** Minimum interval between two `replaceState` calls (default 500 ms). */
  minIntervalMs?: number;
  history?: UrlHistory;
  location?: UrlLocation;
  /** Receives `popstate` (default `window`). */
  target?: UrlSyncTarget;
}

/** Start synchronising; the returned function stops it and cancels any pending write. */
export function startUrlSync(store: SkyStore, options: UrlSyncOptions = {}): () => void {
  const minIntervalMs = options.minIntervalMs ?? 500;
  const history = options.history ?? window.history;
  const location = options.location ?? window.location;
  const target = options.target ?? window;
  const defaults = defaultsUrlState();

  let lastWritten: string = location.search.replace(/^\?/, '');
  let pending: string | null = null;
  let cooldown: number | null = null;
  let applying = false;

  const write = (qs: string): void => {
    if (qs !== lastWritten) {
      lastWritten = qs;
      // The hash is preserved (`#engine=webgl2` in dev/e2e builds) and an empty query leaves no
      // dangling `?`.
      history.replaceState(
        null,
        '',
        location.pathname + (qs === '' ? '' : `?${qs}`) + location.hash,
      );
    }
    cooldown = window.setTimeout(onCooldownEnd, minIntervalMs);
  };

  const onCooldownEnd = (): void => {
    cooldown = null;
    if (pending !== null) {
      const qs = pending;
      pending = null;
      write(qs);
    }
  };

  const schedule = (qs: string): void => {
    if (cooldown === null) {
      write(qs);
    } else {
      pending = qs;
    }
  };

  const unsubscribe = store.subscribe(
    urlStateOf,
    (state) => {
      if (!applying) {
        schedule(serializeUrlState(state, defaults));
      }
    },
    { equalityFn: urlStatesEqual },
  );

  const onPopState = (): void => {
    // A hash-only navigation (`#engine=webgl2` edited in a dev build) fires `popstate` too. The
    // query is then the one this synchroniser wrote or started from: the store already holds it,
    // and re-applying `t` would re-anchor a playing clock up to `minIntervalMs` in the past.
    if (location.search.replace(/^\?/, '') === lastWritten) {
      return;
    }
    // A write scheduled before the navigation would overwrite the restored entry: drop it.
    pending = null;
    if (cooldown !== null) {
      window.clearTimeout(cooldown);
      cooldown = null;
    }
    lastWritten = location.search.replace(/^\?/, '');
    applying = true;
    try {
      store.getState().actions.applyUrl(parseUrlState(location.search));
    } finally {
      applying = false;
    }
  };
  target.addEventListener('popstate', onPopState);

  return () => {
    unsubscribe();
    target.removeEventListener('popstate', onPopState);
    pending = null;
    if (cooldown !== null) {
      window.clearTimeout(cooldown);
      cooldown = null;
    }
  };
}

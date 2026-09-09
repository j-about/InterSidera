// The minor-body defaults (SKY-4, plan D102): `/minor-bodies/defaults` is fetched once the
// `minor` layer is on and `/meta.catalogs.minor_bodies` says the MPC tables are served; the list
// lands in `minorBodies.defaults` and the frame controller composes the `minor` request from it
// and the user's pins (`sky/math/minorBodies.ts::composeMinorRequest`). One attempt per arming:
// turning the layer off and on again, or "retry now" (`boot.retrySeq`), retries after a failure.
// A store subscription, no timer; `stop()` (or the signal) ends it.

import { ApiProblem, getMinorDefaults } from '../api/client';
import type { RequestOptions } from '../api/client';
import type { MinorBodySummary, SkyStore } from './storeTypes';
import type { LoadStatus } from './types';

export interface MinorBodiesDeps {
  /** Replaces the client call (tests); receives the abort signal of the attempt. */
  fetchDefaults?: (signal: AbortSignal) => Promise<readonly MinorBodySummary[]>;
  /** Forwarded to the client (fetch, clock, sleep) when `fetchDefaults` is not given. */
  requestOptions?: RequestOptions;
  /** Aborting stops the subscription and any request in flight. */
  signal?: AbortSignal;
}

/** The status a failed attempt leaves: a 503 means the data group is missing (degraded mode). */
function statusOf(error: unknown): LoadStatus {
  return error instanceof ApiProblem && error.status === 503 ? 'missing' : 'error';
}

export function startMinorBodies(store: SkyStore, deps: MinorBodiesDeps = {}): () => void {
  const { actions } = store.getState();
  const fetchDefaults =
    deps.fetchDefaults ??
    (async (signal: AbortSignal): Promise<readonly MinorBodySummary[]> =>
      (await getMinorDefaults({ ...deps.requestOptions, signal })).data);
  let controller: AbortController | null = null;
  let stopped = false;
  /** The `retrySeq` the current arming attempted; `null` while the layer is off (re-armed). */
  let attempted: number | null = null;

  const evaluate = (): void => {
    if (stopped) {
      return;
    }
    const s = store.getState();
    if (!s.layers.minor) {
      attempted = null;
      return;
    }
    const catalog = s.meta?.catalogs.minor_bodies;
    if (catalog === undefined || catalog === null) {
      return;
    }
    if (s.minorBodies.defaults !== null || s.minorBodies.status === 'loading') {
      return;
    }
    if (attempted === s.boot.retrySeq) {
      return;
    }
    attempted = s.boot.retrySeq;
    controller?.abort();
    const current = new AbortController();
    controller = current;
    const { signal } = current;
    actions.setMinorDefaults(null, 'loading');
    fetchDefaults(signal).then(
      (list) => {
        if (!signal.aborted) {
          actions.setMinorDefaults(list, 'ready');
        }
      },
      (error: unknown) => {
        if (!signal.aborted) {
          actions.setMinorDefaults(null, statusOf(error));
        }
      },
    );
  };

  const unsubscribe = store.subscribe(evaluate);
  const stop = (): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    unsubscribe();
    controller?.abort();
    controller = null;
  };
  deps.signal?.addEventListener('abort', stop, { once: true });
  evaluate();
  return stop;
}

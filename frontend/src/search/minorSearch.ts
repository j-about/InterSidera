// The minor-body half of the unified search (INFO-2, plan D107, Q44): `/minor-bodies/search`
// debounced 400 ms, from two characters, one request in flight (the previous one aborted), only
// while `/meta.catalogs.minor_bodies` says the MPC tables are served, and through the shared
// 429 gate. The submit-only rule of OBS-4 is Nominatim's policy, not ours: the API bucket
// (20 rps, burst 40) absorbs a typing user with room to spare. State changes reach the caller
// through `onChange`; timers and the fetch are injectable for tests.

import { ApiProblem, searchMinorBodies } from '../api/client';
import type { MinorBodySummary, RequestOptions } from '../api/client';
import { sharedRateGate } from '../api/rateGate';
import type { RateGate } from '../api/rateGate';
import type { SearchHit } from './index';

export type MinorSearchStatus =
  'idle' | 'pending' | 'searching' | 'ready' | 'unavailable' | 'error';

export interface MinorSearchState {
  status: MinorSearchStatus;
  /** The text the `hits` answer (trimmed). */
  query: string;
  hits: readonly SearchHit[];
}

export interface MinorSearchDeps {
  /** Replaces the client call (tests): the trimmed text, the row limit and the abort signal. */
  search?: (q: string, limit: number, signal: AbortSignal) => Promise<readonly MinorBodySummary[]>;
  /** Forwarded to the client when `search` is not given. */
  requestOptions?: RequestOptions;
  rateGate?: RateGate;
  now?: () => number;
  debounceMs?: number;
  minChars?: number;
  limit?: number;
  setTimer?: (callback: () => void, ms: number) => number;
  clearTimer?: (id: number) => void;
}

export interface MinorSearch {
  readonly state: MinorSearchState;
  /** Whether the server serves the MPC tables (`/meta.catalogs.minor_bodies` present). */
  setEnabled(on: boolean): void;
  /** The text typed so far; short texts clear the results. */
  query(text: string): void;
  dispose(): void;
}

export const MINOR_SEARCH_DEBOUNCE_MS = 400;
export const MINOR_SEARCH_MIN_CHARS = 2;
export const MINOR_SEARCH_LIMIT = 8;
/** `/minor-bodies/search` accepts 1 to 64 characters (docs/api.md). */
const MAX_QUERY_CHARS = 64;
/** Ranking magnitude of a minor body without `h_mag` (last among the hits). */
const UNKNOWN_H_MAG = 99;

export const IDLE_MINOR_SEARCH: MinorSearchState = { status: 'idle', query: '', hits: [] };

/** A `/minor-bodies/search` row as a search hit. */
export function minorHit(summary: MinorBodySummary): SearchHit {
  const name = summary.name ?? null;
  return {
    id: summary.id,
    kind: 'minor',
    kindKey: summary.kind,
    label: name ?? summary.designation,
    sub: name === null ? '' : summary.designation,
    score: 0,
    mag: summary.h_mag ?? UNKNOWN_H_MAG,
  };
}

export function createMinorSearch(
  onChange: (state: MinorSearchState) => void,
  deps: MinorSearchDeps = {},
): MinorSearch {
  const search =
    deps.search ??
    (async (q: string, limit: number, signal: AbortSignal): Promise<readonly MinorBodySummary[]> =>
      (
        await searchMinorBodies(q, limit, {
          ...deps.requestOptions,
          signal,
          retry: { ...deps.requestOptions?.retry, maxAttempts: 1 },
        })
      ).data);
  const gate = deps.rateGate ?? sharedRateGate;
  const now = deps.now ?? (() => Date.now());
  const debounceMs = deps.debounceMs ?? MINOR_SEARCH_DEBOUNCE_MS;
  const minChars = deps.minChars ?? MINOR_SEARCH_MIN_CHARS;
  const limit = deps.limit ?? MINOR_SEARCH_LIMIT;
  const setTimer = deps.setTimer ?? ((callback, ms) => window.setTimeout(callback, ms));
  const clearTimer =
    deps.clearTimer ??
    ((id) => {
      window.clearTimeout(id);
    });

  let state: MinorSearchState = IDLE_MINOR_SEARCH;
  let enabled = false;
  let text = '';
  let timer: number | null = null;
  let controller: AbortController | null = null;
  let disposed = false;

  const publish = (next: MinorSearchState): void => {
    state = next;
    onChange(next);
  };
  const cancelTimer = (): void => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };
  const abortInFlight = (): void => {
    controller?.abort();
    controller = null;
  };

  const fire = (): void => {
    timer = null;
    if (disposed || !enabled) {
      return;
    }
    const q = text;
    const nowMs = now();
    if (!gate.allowed(nowMs)) {
      // The bucket is empty (a 429 seen by any caller): wait it out, then search once.
      timer = setTimer(fire, Math.max(0, gate.blockedUntilMs() - nowMs));
      return;
    }
    abortInFlight();
    const current = new AbortController();
    controller = current;
    const { signal } = current;
    publish({ status: 'searching', query: q, hits: [] });
    search(q.slice(0, MAX_QUERY_CHARS), limit, signal).then(
      (rows) => {
        if (signal.aborted) {
          return;
        }
        controller = null;
        publish({ status: 'ready', query: q, hits: rows.map(minorHit) });
      },
      (error: unknown) => {
        if (signal.aborted) {
          return;
        }
        controller = null;
        if (error instanceof ApiProblem && error.status === 429) {
          gate.block(error.retryAfterS, now());
          publish({ status: 'pending', query: q, hits: [] });
          timer = setTimer(fire, Math.max(0, gate.blockedUntilMs() - now()));
          return;
        }
        const status: MinorSearchStatus =
          error instanceof ApiProblem && error.status === 503 ? 'unavailable' : 'error';
        publish({ status, query: q, hits: [] });
      },
    );
  };

  const schedule = (): void => {
    cancelTimer();
    abortInFlight();
    if (disposed) {
      return;
    }
    if (text.length < minChars) {
      if (state !== IDLE_MINOR_SEARCH) {
        publish(IDLE_MINOR_SEARCH);
      }
      return;
    }
    if (!enabled) {
      publish({ status: 'unavailable', query: text, hits: [] });
      return;
    }
    publish({ status: 'pending', query: text, hits: [] });
    timer = setTimer(fire, debounceMs);
  };

  return {
    get state() {
      return state;
    },
    setEnabled(on) {
      if (on === enabled) {
        return;
      }
      enabled = on;
      schedule();
    },
    query(value) {
      const trimmed = value.trim().replace(/\s+/g, ' ');
      if (trimmed === text && state.status !== 'idle') {
        return;
      }
      text = trimmed;
      schedule();
    },
    dispose() {
      disposed = true;
      cancelTimer();
      abortInFlight();
    },
  };
}

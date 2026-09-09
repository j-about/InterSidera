// The details controller (INFO-1, plan D106): an engine ticker pulled by `SkyEngine.tick` after
// the frame source with the rendered, clamped `tt` (the engine owns the clock; this module has
// no timer). It issues one `/sky/altaz` request for the selection whenever the selection, the
// observer, the refraction option or the clock's control block changes, and otherwise at most
// once per second while time flows (`mode !== 'paused'`); at most one request is in flight, a
// change aborts the previous one, and a 429 is honoured through the shared gate (plan Q44) and
// reissued once the gate opens. Errors follow docs/api.md: only a 404 means the object is unknown
// (the selection is cleared with a toast); a 400 or 422 keeps the selection with its message; a
// 503 says the data group is missing; a network error or a 5xx keeps the last entry and backs
// off. A 429 or a failure is retried after its wait even while paused (a retry is not a cadence
// refresh: without it a paused selection would show the error until the next change). Nothing
// is asked before the boot is `ready`: the engine ticks from its construction, in parallel with
// the boot, and a toast raised behind the splash would be gone before the user sees the sky. The
// constellation is set at once from the catalogs (`con` of the star index or the DSO row) and
// replaced by the authoritative `constellation` of every answer (plan D103, no client-side
// polygon test).

import type { CatalogBundle } from '../api/catalogs';
import { ApiProblem, getAltAz, isAbortError, observerQuery } from '../api/client';
import type { AltAzEntry, ProblemSlug, QueryOf, RequestOptions } from '../api/client';
import { sharedRateGate } from '../api/rateGate';
import type { RateGate } from '../api/rateGate';
import type { EngineTicker } from '../sky/engine/types';
import type { DetailsState, SkyStore } from './storeTypes';
import type { ClockControl } from './types';

export type AltAzQuery = QueryOf<'/api/v1/sky/altaz'>;

export interface DetailsControllerDeps {
  store: SkyStore;
  /** Replaces the client call (tests): the query and the abort signal of the attempt. */
  fetchAltAz?: (query: AltAzQuery, signal: AbortSignal) => Promise<AltAzEntry[]>;
  /** Forwarded to the client when `fetchAltAz` is not given. */
  requestOptions?: RequestOptions;
  /** The 429 gate shared with the minor-body search (defaults to the application's). */
  rateGate?: RateGate;
  /** Wall clock for the response-side bookkeeping (defaults to `Date.now`). */
  now?: () => number;
}

export interface DetailsController extends EngineTicker {
  dispose(): void;
}

/** While time flows the authoritative row is refreshed at most this often (brief l.230). */
export const DETAILS_REFRESH_MS = 1000;
/** Backoff after a network error or a 5xx: `1 s * 2^failures` (2 s, 4 s, ...), capped. */
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

const HIP_RE = /^hip:(\d+)$/;
const DSO_RE = /^dso:(.+)$/;

/** Constellation lookups by id from the catalogs, built once per bundle. */
class BundleConstellations {
  private readonly byHip = new Map<number, string>();
  private readonly byDso = new Map<string, string>();

  constructor(bundle: CatalogBundle) {
    for (const star of bundle.index.data) {
      this.byHip.set(star.hip, star.con);
    }
    for (const dso of bundle.dso?.data ?? []) {
      this.byDso.set(dso.id.toUpperCase(), dso.con);
      if (dso.messier !== undefined && dso.messier !== null) {
        this.byDso.set(`M${String(dso.messier)}`, dso.con);
      }
    }
  }

  /** `con` of a `hip:` or `dso:` id (Messier alias accepted), `null` for anything else. */
  conOf(id: string): string | null {
    const hip = HIP_RE.exec(id);
    if (hip !== null) {
      return this.byHip.get(Number(hip[1])) ?? null;
    }
    const dso = DSO_RE.exec(id);
    if (dso !== null) {
      return this.byDso.get((dso[1] ?? '').toUpperCase()) ?? null;
    }
    return null;
  }
}

function sameControl(a: ClockControl, b: ClockControl): boolean {
  return (
    a.mode === b.mode &&
    a.speed === b.speed &&
    a.ttAnchor === b.ttAnchor &&
    a.wallAnchorMs === b.wallAnchorMs
  );
}

function controlOf(control: ClockControl): ClockControl {
  return {
    mode: control.mode,
    speed: control.speed,
    ttAnchor: control.ttAnchor,
    wallAnchorMs: control.wallAnchorMs,
  };
}

/** The `DetailsState.error` of a failed request. */
function errorOf(error: unknown): NonNullable<DetailsState['error']> {
  if (error instanceof ApiProblem) {
    const slug: ProblemSlug = error.slug;
    return error.rangeTt === undefined
      ? { status: error.status, slug }
      : { status: error.status, slug, rangeTt: error.rangeTt };
  }
  return { status: 0, slug: 'unknown' };
}

export function createDetailsController(deps: DetailsControllerDeps): DetailsController {
  const { store } = deps;
  const { actions } = store.getState();
  const fetchAltAz =
    deps.fetchAltAz ??
    (async (query: AltAzQuery, signal: AbortSignal): Promise<AltAzEntry[]> =>
      (
        await getAltAz(query, {
          ...deps.requestOptions,
          signal,
          retry: { ...deps.requestOptions?.retry, maxAttempts: 1 },
        })
      ).data);
  const gate = deps.rateGate ?? sharedRateGate;
  const now = deps.now ?? (() => Date.now());

  let disposed = false;
  let controller: AbortController | null = null;
  /** What the last request was issued for. */
  let lastSelection: string | null = null;
  let lastObserver = store.getState().observer;
  /** The effective flag sent (`refr && on Earth`): toggling `refr` off Earth changes nothing. */
  let lastRefraction = false;
  let lastControl: ClockControl | null = null;
  /** Wall time of the last request issued (the 1 Hz cadence), `-Infinity` before the first. */
  let lastRequestMs = -Infinity;
  /** Consecutive network or 5xx failures of the current selection (the backoff exponent). */
  let failures = 0;
  /** A retry is owed (after a 429, a network error or a 5xx), not before `retryNotBeforeMs`. */
  let retryPending = false;
  let retryNotBeforeMs = -Infinity;
  const clearRetry = (): void => {
    failures = 0;
    retryPending = false;
    retryNotBeforeMs = -Infinity;
  };
  let bundleSeen: CatalogBundle | null = null;
  let constellations: BundleConstellations | null = null;

  const abortInFlight = (): void => {
    controller?.abort();
    controller = null;
  };

  const catalogCon = (id: string): string | null => {
    const bundle = store.getState().bundle;
    if (bundle !== bundleSeen) {
      bundleSeen = bundle;
      constellations = bundle === null ? null : new BundleConstellations(bundle);
    }
    return constellations?.conOf(id) ?? null;
  };

  const request = (selection: string, tt: number, nowMs: number): void => {
    const s = store.getState();
    const refraction = s.options.refr && s.observer.body === 'earth';
    const query: AltAzQuery = {
      ...observerQuery(s.observer),
      tt,
      targets: selection,
      refraction,
    };
    abortInFlight();
    const current = new AbortController();
    controller = current;
    const { signal } = current;
    lastRequestMs = nowMs;
    lastSelection = selection;
    lastObserver = s.observer;
    lastRefraction = refraction;
    lastControl = controlOf(s.clock);
    if (s.details.status !== 'ready' || s.details.id !== selection) {
      actions.setDetails({ id: selection, status: 'loading' });
    }
    fetchAltAz(query, signal).then(
      (rows) => {
        if (signal.aborted || disposed) {
          return;
        }
        controller = null;
        clearRetry();
        const entry = rows.find((row) => row.id === selection) ?? rows[0] ?? null;
        if (entry === null) {
          actions.setDetails({
            id: selection,
            status: 'error',
            error: { status: 0, slug: 'unknown' },
          });
          return;
        }
        const con = entry.constellation ?? catalogCon(selection);
        actions.setDetails({
          id: selection,
          status: 'ready',
          entry,
          tt,
          refraction,
          con,
          error: null,
        });
      },
      (error: unknown) => {
        if (signal.aborted || disposed || isAbortError(error)) {
          return;
        }
        controller = null;
        const status = error instanceof ApiProblem ? error.status : 0;
        const detailsError = errorOf(error);
        if (status === 404) {
          // Unknown object (docs/api.md problem-unknown-object): the selection cannot stand.
          actions.setDetails({ id: selection, status: 'error', entry: null, error: detailsError });
          actions.select(null);
          actions.showToast('details.unknown');
          return;
        }
        if (status === 429) {
          // The gate holds every caller back; this request is owed again once it opens, paused
          // or not (a paused selection has no cadence to pick it up).
          gate.block(error instanceof ApiProblem ? error.retryAfterS : undefined, now());
          retryPending = true;
          retryNotBeforeMs = gate.blockedUntilMs();
          actions.setDetails({ id: selection, status: 'error', error: detailsError });
          return;
        }
        if (status === 400 || status === 422 || status === 503) {
          // The selection stays; the panel shows the contract's message (400: refused, 422:
          // outside coverage with `rangeTt`, 503: the data group is missing on this server).
          actions.setDetails({ id: selection, status: 'error', error: detailsError });
          return;
        }
        // Network error or a 5xx: keep whatever entry we had and back off.
        failures += 1;
        retryPending = true;
        retryNotBeforeMs = now() + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** failures);
        actions.setDetails({ id: selection, status: 'error', error: detailsError });
      },
    );
  };

  const update = (tt: number, nowMs: number): void => {
    if (disposed) {
      return;
    }
    const s = store.getState();
    const selection = s.selection;
    if (selection === null) {
      if (lastSelection !== null || s.details.id !== null) {
        abortInFlight();
        lastSelection = null;
        lastControl = null;
        clearRetry();
        actions.setDetails({
          id: null,
          status: 'idle',
          entry: null,
          tt: NaN,
          refraction: false,
          con: null,
          error: null,
        });
      }
      return;
    }
    if (s.boot.phase !== 'ready' || !Number.isFinite(tt)) {
      // The selection waits for the boot: the API is not known to answer before `/meta`, and a
      // 404 toast raised behind the splash would auto-hide before the sky appears.
      return;
    }
    const selectionChanged = selection !== lastSelection;
    if (selectionChanged) {
      // The catalogs know the constellation of a star or a deep-sky object at once; the
      // authoritative value of the answer replaces it (plan D103).
      abortInFlight();
      clearRetry();
      actions.setDetails({
        id: selection,
        status: 'loading',
        entry: null,
        tt: NaN,
        refraction: false,
        con: catalogCon(selection),
        error: null,
      });
    }
    const changed =
      selectionChanged ||
      s.observer !== lastObserver ||
      (s.options.refr && s.observer.body === 'earth') !== lastRefraction ||
      lastControl === null ||
      !sameControl(s.clock, lastControl);
    if (!changed) {
      if (controller !== null) {
        return;
      }
      if (retryPending) {
        // A refused or failed request is retried once its wait has passed, paused or not (the
        // backoff, 2 s at least, and `Retry-After`, 1 s at least, already exceed the cadence).
        if (nowMs < retryNotBeforeMs) {
          return;
        }
      } else if (s.clock.mode === 'paused' || nowMs - lastRequestMs < DETAILS_REFRESH_MS) {
        return;
      }
    }
    if (!gate.allowed(nowMs)) {
      // A 429 seen by any caller holds the request; the next tick after the gate opens issues it.
      return;
    }
    request(selection, tt, nowMs);
  };

  return {
    update,
    dispose() {
      disposed = true;
      abortInFlight();
    },
  };
}

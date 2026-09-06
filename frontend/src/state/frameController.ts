// Frame controller (plan D76, D77; brief l.67-70, l.281): the impure half of the frame buffer
// and the `FrameSource` the engine pulls from. On every tick it builds the simulation input from
// the store, runs the pure `decide`, starts or cancels requests through an injectable fetcher,
// stores at most two windows (`current`, `next`) and mirrors the buffer status into the store.
// Failures never stall the picture: the engine keeps extrapolating from the last window while a
// request is in flight or backing off (brief l.281).

import { ApiProblem, backoffDelayMs, getFrame } from '../api/client';
import type { FrameResponse } from '../api/client';
import type { FrameSource } from '../sky/engine/types';
import { DAY_S } from '../sky/math/time';
import {
  boundedRequest,
  buildRequest,
  clampInsideCoverage,
  decide,
  evaluate as evaluateWindow,
  requestKey,
  shapeKey,
  stepClassesOf,
  windowCovers,
  windowFromResponse,
} from './frames';
import type { FetchReason, FetchState, FrameQuery, FrameWindow, SimInput } from './frames';
import type { MetaResponse, SkyStore } from './storeTypes';
import type { FrameEval, FramesState, SkyWarning } from './types';

export type FrameFetcher = (query: FrameQuery, signal: AbortSignal) => Promise<FrameResponse>;

export interface FrameController extends FrameSource {
  dispose(): void;
  readonly state: Readonly<FetchState>;
}

export interface FrameControllerDeps {
  store: SkyStore;
  /** Defaults to `getFrame` with the client retry policy minus 503 (handled here). */
  fetchFrame?: FrameFetcher;
  now?: () => number;
  /** Every non-abort failure, after it was handled (for a console line in dev builds). */
  onError?: (error: unknown) => void;
  /** Jitter source of the backoff (tests inject a constant). */
  random?: () => number;
}

/**
 * The policy runs at most this often when nothing changed in the store (brief l.68 recomputes
 * derived state at <= 10 Hz): `decide` builds a request and its key on every run and a 60 Hz
 * loop needs neither. A store change (jump, observer, speed) still runs it on the same tick.
 */
export const DECIDE_INTERVAL_MS = 100;
/** A 503 whose `Retry-After` reaches this is a missing data group, not a hiccup (plan D76). */
export const BLOCKING_RETRY_AFTER_S = 30;

const NO_MINOR: readonly string[] = [];

/**
 * Default fetcher: one `/sky/frame` request through the client (D77 policy: 429/502/504 and
 * network errors retried with backoff inside). 503 is excluded from the client's retries so the
 * controller sees it at once: a long `Retry-After` means the data group is missing and the
 * request shape must not be retried at all (plan D76), a short one backs off here.
 */
const defaultFetcher: FrameFetcher = async (query, signal) => {
  const { data } = await getFrame(query, {
    signal,
    retry: { retryOnStatus: (status) => status === 429 || status === 502 || status === 504 },
  });
  return data;
};

interface Waiter {
  tt: number | undefined;
  resolve: () => void;
}

/** A snapshot covers its step for readiness purposes: it is the best the sky can show. */
function readyCovers(window: FrameWindow, tt: number): boolean {
  return window.n < 2 ? Math.abs(tt - window.tt0) <= window.stepD : windowCovers(window, tt);
}

export function createFrameController(deps: FrameControllerDeps): FrameController {
  const { store } = deps;
  // `actions` is a stable object of the state (storeTypes.ts), read once.
  const { actions } = store.getState();
  const fetchFrame = deps.fetchFrame ?? defaultFetcher;
  const now = deps.now ?? (() => Date.now());
  const random = deps.random ?? (() => Math.random());

  const state: FetchState = {
    current: null,
    next: null,
    inFlight: null,
    lastSnapshotDoneMs: -Infinity,
    failedKey: null,
    failedShape: null,
  };
  // The sim block is mutated in place on every tick: nothing is allocated per frame here.
  const sim: SimInput = {
    observer: store.getState().observer,
    tt: NaN,
    speed: 0,
    mode: 'paused',
    bodyIds: [],
    stepClassOf: new Map<string, string>(),
    maxStepS: {},
    minor: NO_MINOR,
  };
  let metaSeen: MetaResponse | null = null;
  let bodyIdsFor: string | null = null;
  let inFlightController: AbortController | null = null;
  let disposed = false;
  let lastTt = NaN;
  let lastDecideMs = -Infinity;
  let lastObserver = store.getState().observer;
  let lastClock = store.getState().clock;
  let settledSinceDecide = false;
  // Backoff after a retryable failure applies to that request shape only (plan D76): `failures`
  // counts consecutive failures of `retryShape`. The shape, not the key: the aligned `tt0` moves
  // one bucket per `step_s` of simulated time, and a ladder keyed on it would restart at every
  // bucket instead of growing (brief l.281).
  let failures = 0;
  let retryShape: string | null = null;
  let retryNotBeforeMs = -Infinity;
  const waiters: Waiter[] = [];
  let published: FramesState = store.getState().frames;

  function publish(patch: Partial<FramesState>): void {
    let changed = false;
    for (const key of Object.keys(patch) as (keyof FramesState)[]) {
      if (patch[key] !== published[key]) {
        changed = true;
        break;
      }
    }
    if (changed) {
      published = { ...published, ...patch };
      actions.setFrames(patch);
    }
  }

  function currentChanged(window: FrameWindow): void {
    actions.setTtMinusUtc(window.ttMinusUtc);
    const warnings: SkyWarning[] = [...window.warnings.observer, ...window.warnings.time];
    publish({
      status: 'ready',
      window: {
        tt0: window.tt0,
        // The API echoes an integer `step_s`; the division to days and back is undone exactly.
        stepS: Math.round(window.stepD * DAY_S),
        n: window.n,
        bodies: window.bodyIds,
      },
      snapshot: window.n < 2,
      warnings,
    });
  }

  function isCovered(tt: number | undefined): boolean {
    const target = tt ?? lastTt;
    if (Number.isNaN(target)) {
      return false;
    }
    return (
      (state.current !== null && readyCovers(state.current, target)) ||
      (state.next !== null && readyCovers(state.next, target))
    );
  }

  function checkWaiters(): void {
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const waiter = waiters[i];
      if (waiter !== undefined && isCovered(waiter.tt)) {
        waiters.splice(i, 1);
        waiter.resolve();
      }
    }
  }

  function refreshMeta(meta: MetaResponse, observerBody: string): void {
    if (meta !== metaSeen) {
      const classes = stepClassesOf(meta.bodies, meta.limits);
      sim.stepClassOf = classes.stepClassOf;
      sim.maxStepS = classes.maxStepS;
      metaSeen = meta;
      bodyIdsFor = null;
    }
    if (bodyIdsFor !== observerBody) {
      // The observer is excluded server-side too (docs/api.md), but the step clamp must not see
      // it: an Earth observer would otherwise bound every window by the Moon class.
      sim.bodyIds = meta.bodies.map((body) => body.id).filter((id) => id !== observerBody);
      bodyIdsFor = observerBody;
    }
  }

  /** The key the paused simulation now produces, blocked after a 422 so it is not re-issued. */
  function blockCurrentShape(): void {
    const s = store.getState();
    sim.tt = s.clock.tt;
    sim.speed = s.clock.speed;
    sim.mode = s.clock.mode;
    state.failedKey = requestKey(buildRequest(sim));
  }

  function settle(
    controller: AbortController,
    response: FrameResponse,
    request: FrameQuery,
    reason: FetchReason,
    speed: number,
  ): void {
    if (inFlightController !== controller) {
      return; // superseded or disposed; the abort may not have reached the fetcher yet
    }
    let window: FrameWindow;
    try {
      window = windowFromResponse(response, request, speed);
    } catch (error) {
      fail(controller, error, request, reason, speed);
      return;
    }
    inFlightController = null;
    state.inFlight = null;
    failures = 0;
    retryShape = null;
    state.failedKey = null;
    state.failedShape = null;
    publish({ lastError: null });
    if (window.n < 2) {
      state.lastSnapshotDoneMs = now();
    }
    if (reason === 'prefetch' && state.current !== null) {
      state.next = window;
    } else {
      state.current = window;
      state.next = null;
      currentChanged(window);
    }
    settledSinceDecide = true;
    checkWaiters();
  }

  function fail(
    controller: AbortController,
    error: unknown,
    request: FrameQuery,
    reason: FetchReason,
    speed: number,
  ): void {
    if (inFlightController !== controller) {
      // Superseded or disposed. Our own abort always lands here: `start` and `dispose` replace
      // the controller synchronously and the rejection is delivered a microtask later.
      return;
    }
    inFlightController = null;
    state.inFlight = null;
    settledSinceDecide = true;
    if (request.n === 1) {
      state.lastSnapshotDoneMs = now();
    }
    if (error instanceof ApiProblem) {
      if (error.status === 422 && error.slug === 'outside-coverage') {
        if (reason === 'prefetch' && state.current !== null) {
          // The continuation leaves the coverage while `current` is still valid: block that
          // request alone and keep playing. Pausing here would re-issue a fresh 1 s-step
          // continuation on every tick (the paused shape differs from the failed one); the
          // refetch at the seam takes the branch below and stops the clock (plan D76).
          state.failedKey = requestKey(request);
          deps.onError?.(error);
          return;
        }
        // Hard coverage limit (brief l.169; plan D76 "pause at `range_tt`"): stop the clock one
        // guard inside the bound when the time itself lies outside `range_tt`, else where it is
        // (the window, not `tt`, left the coverage), and refetch the same shape flush with the
        // bound so the sky at the bound renders (a cold start there would otherwise end in an
        // error). Only when that refetch is refused too, or `range_tt` is missing, is the paused
        // shape blocked so the same 422 is not requested again; the picture stays valid while a
        // window exists.
        const nowMs = now();
        actions.pause(nowMs);
        deps.onError?.(error);
        if (error.rangeTt !== undefined) {
          const paused = store.getState().clock.tt;
          const clamped = clampInsideCoverage(paused, error.rangeTt);
          if (clamped !== paused) {
            actions.setTime(clamped, nowMs);
          }
          const bounded = reason === 'bound' ? null : boundedRequest(request, error.rangeTt);
          if (bounded !== null) {
            start(bounded, 'bound', speed, nowMs);
            return;
          }
        }
        blockCurrentShape();
        if (state.current === null) {
          publish({ status: 'error', lastError: { status: error.status, blocked: true } });
        }
        return;
      }
      const blockingUnavailable =
        error.status === 503 && (error.retryAfterS ?? 0) >= BLOCKING_RETRY_AFTER_S;
      const contractError = error.status >= 400 && error.status < 500 && error.status !== 429;
      if (blockingUnavailable || contractError) {
        // Refused for good and independent of the time: the shape stays blocked whatever the
        // clock does (plan D76; a moving `tt0` must not re-issue it every step).
        state.failedShape = shapeKey(request);
        if (state.current === null) {
          publish({ status: 'error', lastError: { status: error.status, blocked: true } });
        }
        deps.onError?.(error);
        return;
      }
    }
    // Transient (network, 429, 5xx, malformed body, a fetcher that gave up on its own with an
    // AbortError): exponential backoff on this shape while the engine keeps extrapolating
    // (brief l.281). The counter belongs to one shape: another shape starts its ladder afresh.
    const shape = shapeKey(request);
    if (shape !== retryShape) {
      failures = 0;
    }
    failures += 1;
    retryShape = shape;
    retryNotBeforeMs =
      now() +
      backoffDelayMs(
        failures - 1,
        error instanceof ApiProblem ? error.retryAfterS : undefined,
        random,
      );
    if (state.current === null) {
      publish({
        status: 'error',
        lastError: { status: error instanceof ApiProblem ? error.status : 0, blocked: false },
      });
    }
    deps.onError?.(error);
  }

  function start(request: FrameQuery, reason: FetchReason, speed: number, nowMs: number): void {
    inFlightController?.abort();
    const controller = new AbortController();
    inFlightController = controller;
    state.inFlight = { request, key: requestKey(request), startedMs: nowMs, speed };
    if (state.current === null) {
      publish({ status: 'loading' });
    }
    void fetchFrame(request, controller.signal).then(
      (response) => {
        settle(controller, response, request, reason, speed);
      },
      (error: unknown) => {
        fail(controller, error, request, reason, speed);
      },
    );
  }

  function update(tt: number, nowMs: number): void {
    if (disposed) {
      return;
    }
    const s = store.getState();
    if (s.meta === null) {
      return;
    }
    lastTt = tt;
    const storeChanged =
      s.observer !== lastObserver || s.clock !== lastClock || s.meta !== metaSeen;
    if (!storeChanged && !settledSinceDecide && nowMs - lastDecideMs < DECIDE_INTERVAL_MS) {
      checkWaiters();
      return;
    }
    lastObserver = s.observer;
    lastClock = s.clock;
    lastDecideMs = nowMs;
    settledSinceDecide = false;
    refreshMeta(s.meta, s.observer.body);
    sim.observer = s.observer;
    sim.tt = tt;
    sim.speed = s.clock.speed;
    sim.mode = s.clock.mode;

    const decision = decide(state, sim, nowMs);
    if (decision.swapToNext && state.next !== null) {
      state.current = state.next;
      state.next = null;
      currentChanged(state.current);
    }
    if (decision.dropNext) {
      state.next = null;
    }
    if (decision.fetch !== null && decision.reason !== null) {
      const backingOff = shapeKey(decision.fetch) === retryShape && nowMs < retryNotBeforeMs;
      if (!backingOff) {
        start(decision.fetch, decision.reason, sim.mode === 'live' ? 1 : sim.speed, nowMs);
      }
    }
    publish({ extrapolating: decision.extrapolating });
    checkWaiters();
  }

  function evaluate(tt: number, out: FrameEval): void {
    const window = state.next !== null && windowCovers(state.next, tt) ? state.next : state.current;
    if (window === null) {
      out.valid = false;
      return;
    }
    evaluateWindow(window, tt, out);
  }

  function whenCovering(tt?: number): Promise<void> {
    return new Promise<void>((resolve) => {
      if (isCovered(tt)) {
        resolve();
        return;
      }
      waiters.push({ tt, resolve });
    });
  }

  function dispose(): void {
    disposed = true;
    inFlightController?.abort();
    inFlightController = null;
    state.inFlight = null;
  }

  return {
    update,
    evaluate,
    whenCovering,
    dispose,
    get state(): Readonly<FetchState> {
      return state;
    },
  };
}

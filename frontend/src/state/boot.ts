// Boot sequence (plan D87, brief l.65-66): `/health` until the API is up (progress or a fatal
// detail while `starting`, ADR-0008) with `/meta` requested alongside it (plan D138: one round
// trip less on a cold boot; a 503 or a network failure on `/meta` defers to the poll and sends
// the sequence back to `/health`), the catalogs in parallel, the engine, then the first frame
// window; every step is mirrored into the store's `boot` block so the splash (M3) and the banners
// (M4) render from state alone, and stamped with a `performance.mark('sky:<phase>')` for the
// boot measurements (plan D141; the marks carry no data). Aborting the signal stops the sequence
// silently between any two awaits (React StrictMode double effect, brief l.551).

import { loadCatalogs } from '../api/catalogs';
import type { CatalogBundle } from '../api/catalogs';
import { ApiProblem, NetworkError, getMeta, isAbortError, pollHealth } from '../api/client';
import type { HealthResponse, MetaResponse, RequestOptions } from '../api/client';
import { WebGL2UnavailableError } from '../sky/engine/types';
import type { SkyEngineApi, StarCatalogInput } from '../sky/engine/types';
import type { FrameController } from './frameController';
import { stepClassesOf } from './frames';
import { startMinorBodies } from './minorBodies';
import type { SkyStore } from './storeTypes';
import type { FramesState } from './types';

export interface BootDeps {
  store: SkyStore;
  frames: FrameController;
  /** The engine factory's promise; `WebGL2UnavailableError` becomes the `webgl2` boot error. */
  engine: Promise<SkyEngineApi>;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface BootHandle {
  /** Settles when the boot reached `ready`, an error phase, or was aborted; never rejects. */
  done: Promise<void>;
  catalog: () => StarCatalogInput | null;
  bundle: () => CatalogBundle | null;
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

/** `promise`, or an abort rejection as soon as `signal` fires (a pending wait must not outlive it). */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = (): void => {
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** The first frame request was refused for good (422 outside coverage, another 4xx, a long 503). */
class FirstFrameError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`the first frame request failed with HTTP ${String(status)}`);
    this.name = 'FirstFrameError';
    this.status = status;
  }
}

/**
 * Rejects with `FirstFrameError` as soon as the frame controller records a blocked request while
 * no window is loaded; `whenCovering()` would otherwise wait forever and the splash never end
 * (plan D87). `dispose` drops the subscription once the race is over.
 */
function firstFrameBlocked(store: SkyStore): { promise: Promise<never>; dispose: () => void } {
  let unsubscribe: (() => void) | null = null;
  let settled = false;
  const promise = new Promise<never>((_, reject) => {
    const check = (frames: FramesState): void => {
      if (!settled && frames.window === null && frames.lastError?.blocked === true) {
        settled = true;
        reject(new FirstFrameError(frames.lastError.status));
      }
    };
    unsubscribe = store.subscribe((state) => state.frames, check, { fireImmediately: true });
  });
  return {
    promise,
    dispose: () => {
      settled = true;
      unsubscribe?.();
    },
  };
}

/** The API answered but is not serving yet, or the network dropped: poll `/health` again. */
function sendsBackToHealth(error: unknown): boolean {
  return error instanceof NetworkError || (error instanceof ApiProblem && error.status === 503);
}

/**
 * `performance.mark(name)` where the platform has it (plan D141): jsdom 30 implements `now()`
 * alone, so the guard reads the method through an `unknown`-typed view (the DOM typing says it
 * always exists). The marks are read back by the dev/e2e debug hook and carry no data.
 */
export function markPhase(name: `sky:${string}`): void {
  const perf: { mark?: unknown } = performance;
  if (typeof perf.mark === 'function') {
    performance.mark(name);
  }
}

export function startBoot(deps: BootDeps): BootHandle {
  const { store, signal } = deps;
  const { actions } = store.getState();
  // Read through a call: TypeScript narrows `signal.aborted` to `false` after one check and
  // keeps that across awaits, although the flag flips at any time.
  const aborted = (): boolean => signal.aborted;
  const now = deps.now ?? (() => Date.now());
  let bundle: CatalogBundle | null = null;

  // A rejection before the sequence reaches the engine must not surface as unhandled.
  void deps.engine.then(undefined, () => undefined);

  // `exactOptionalPropertyTypes`: an absent injection stays absent so the client picks its
  // platform defaults (`fetch`, a timer sleep).
  const requestOptions: RequestOptions = { now, signal };
  if (deps.fetchImpl !== undefined) {
    requestOptions.fetchImpl = deps.fetchImpl;
  }
  if (deps.sleep !== undefined) {
    requestOptions.sleep = deps.sleep;
  }
  // The minor-body defaults follow the `minor` layer for the whole session (plan D102); the
  // subscription lives with the boot's signal, like everything the shell creates.
  startMinorBodies(store, { requestOptions, signal });

  /** A `503 starting` body: download progress, or the bootstrap's fatal reason (ADR-0008). */
  function onHealthUpdate(health: HealthResponse): void {
    actions.setHealth(health);
    const progress = health.progress ?? null;
    // The API itself answered, which resets the poll's unreachable schedule (client.ts): its
    // mirrors are cleared with it so the splash stops counting attempts.
    actions.setBoot({
      attempt: 0,
      retryAtMs: null,
      progress:
        progress === null
          ? null
          : {
              file: progress.file,
              downloadedBytes: progress.downloaded_bytes,
              totalBytes: progress.total_bytes,
            },
      error:
        typeof health.detail === 'string' && health.detail !== ''
          ? { kind: 'fatal', detail: health.detail }
          : null,
    });
  }

  /**
   * The API could not be reached (`fetch` failed, or a proxy answered a retryable status) and
   * the poll backs off for `delayMs`: the splash shows `boot.unreachable` with the retry time
   * (plan D87; the UX-6 banner and the retry button are M4).
   */
  function onHealthRetry(attempt: number, delayMs: number): void {
    actions.setBoot({ attempt, retryAtMs: now() + delayMs, error: { kind: 'unreachable' } });
  }

  /**
   * `/meta`, or `null` when the API is still starting (503) or the network dropped: the poll's
   * outcome decides then. A 503 is never retried by the client here (it would retry silently
   * five times while `/health` shows the progress). Any other failure rejects.
   */
  async function metaOrNull(): Promise<MetaResponse | null> {
    try {
      return (
        await getMeta({
          ...requestOptions,
          retry: {
            retryOnStatus: (status) => status === 429 || status === 502 || status === 504,
          },
        })
      ).data;
    } catch (error) {
      if (aborted() || isAbortError(error) || !sendsBackToHealth(error)) {
        throw error;
      }
      return null;
    }
  }

  /**
   * `/health` and `/meta` together (plan D138), looping back to `/health` while the API is
   * starting or unreachable. `setHealth` still precedes `setBoot({ phase: 'meta' })`: the splash
   * reads `health.status` and the About dialog `health.version`.
   */
  async function healthAndMeta(): Promise<MetaResponse | null> {
    for (;;) {
      if (aborted()) {
        return null;
      }
      actions.setBoot({ phase: 'health' });
      markPhase('sky:health');
      // Both requests leave now, the poll first (it owns the splash); `/meta` is read after it.
      const polling = pollHealth({
        ...requestOptions,
        onUpdate: onHealthUpdate,
        onRetry: onHealthRetry,
      });
      const meta = metaOrNull();
      // A `/meta` rejection that lands before the poll ends (or during an abort) must not surface
      // as unhandled meanwhile; `await meta` below still throws it.
      void meta.catch(() => undefined);
      const health = await polling;
      if (aborted()) {
        return null;
      }
      actions.setHealth(health);
      actions.setBoot({ phase: 'meta', progress: null, error: null, attempt: 0, retryAtMs: null });
      markPhase('sky:meta');
      const data = await meta;
      if (data !== null) {
        return data;
      }
      // `/meta` said 503 (or the network dropped) while `/health` answered: the API went back to
      // `starting`, or the answers crossed; the poll shows the progress until both agree (one
      // more `/health` round trip, and `sky:health`/`sky:meta` marked again, in that case only).
    }
  }

  async function run(): Promise<void> {
    try {
      let meta: MetaResponse | null = null;
      while (meta === null) {
        meta = await healthAndMeta();
        if (meta === null) {
          return; // aborted
        }
        // Contract check before anything depends on it (plan D76): an unknown class throws.
        stepClassesOf(meta.bodies, meta.limits);
        actions.setMeta(meta);
        actions.setTtMinusUtc(meta.server_time.tt_minus_utc_seconds);
        actions.setBoot({ phase: 'catalogs' });
        markPhase('sky:catalogs');
        try {
          bundle = await loadCatalogs(meta, {
            ...requestOptions,
            onStatus: (name, status) => {
              actions.setCatalogStatus(name, status);
            },
          });
        } catch (error) {
          if (aborted() || isAbortError(error) || !sendsBackToHealth(error)) {
            throw error;
          }
          meta = null; // a required catalog went away with the API: start over at /health
        }
      }
      if (aborted() || bundle === null) {
        return;
      }
      // The catalogs reach the engine (DSO, constellations, labels) and the search index through
      // the store (plan D92); the star catalog is handed over directly below.
      actions.setBundle(bundle);
      // The factory disposes on abort itself (SkyEngineOptions.signal); racing keeps `done`
      // settling even when a factory ignores it.
      const engine = await raceAbort(deps.engine, signal);
      if (aborted()) {
        return;
      }
      engine.setCatalog(bundle.stars);
      actions.setBoot({ phase: 'frame' });
      markPhase('sky:frame');
      const blocked = firstFrameBlocked(store);
      try {
        await raceAbort(Promise.race([deps.frames.whenCovering(), blocked.promise]), signal);
      } finally {
        blocked.dispose();
      }
      if (aborted()) {
        return;
      }
      actions.setBoot({ phase: 'ready' });
      markPhase('sky:ready');
    } catch (error) {
      if (aborted() || isAbortError(error)) {
        return;
      }
      if (error instanceof WebGL2UnavailableError) {
        actions.setBoot({ phase: 'error', error: { kind: 'webgl2' } });
        return;
      }
      if (error instanceof ApiProblem || error instanceof FirstFrameError) {
        actions.setBoot({ phase: 'error', error: { kind: 'http', status: error.status } });
        return;
      }
      actions.setBoot({
        phase: 'error',
        error: { kind: 'fatal', detail: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  return {
    done: run(),
    catalog: () => (bundle === null ? null : bundle.stars),
    bundle: () => bundle,
  };
}

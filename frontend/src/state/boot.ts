// Boot sequence (plan D87, brief l.65-66): `/health` until the API is up (progress or a fatal
// detail while `starting`, ADR-0008), `/meta` (a 503 sends it back to `/health`), the catalogs in
// parallel, the engine, then the first frame window; every step is mirrored into the store's
// `boot` block so the splash (M3) and the banners (M4) render from state alone. Aborting the
// signal stops the sequence silently between any two awaits (React StrictMode double effect,
// brief l.551).

import { loadCatalogs } from '../api/catalogs';
import type { CatalogBundle } from '../api/catalogs';
import { ApiProblem, NetworkError, getMeta, isAbortError, pollHealth } from '../api/client';
import type { HealthResponse, MetaResponse, RequestOptions } from '../api/client';
import { WebGL2UnavailableError } from '../sky/engine/types';
import type { SkyEngineApi, StarCatalogInput } from '../sky/engine/types';
import type { FrameController } from './frameController';
import { stepClassesOf } from './frames';
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

  /** `/health` then `/meta`, looping back to `/health` while the API is starting or unreachable. */
  async function healthAndMeta(): Promise<MetaResponse | null> {
    for (;;) {
      if (aborted()) {
        return null;
      }
      actions.setBoot({ phase: 'health' });
      const health = await pollHealth({
        ...requestOptions,
        onUpdate: onHealthUpdate,
        onRetry: onHealthRetry,
      });
      if (aborted()) {
        return null;
      }
      actions.setHealth(health);
      actions.setBoot({ phase: 'meta', progress: null, error: null, attempt: 0, retryAtMs: null });
      try {
        // A 503 here means the API went back to `starting`: return to `/health` at once, where
        // the progress is shown, instead of letting the client retry it silently five times.
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
      }
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
      // The factory disposes on abort itself (SkyEngineOptions.signal); racing keeps `done`
      // settling even when a factory ignores it.
      const engine = await raceAbort(deps.engine, signal);
      if (aborted()) {
        return;
      }
      engine.setCatalog(bundle.stars);
      actions.setBoot({ phase: 'frame' });
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

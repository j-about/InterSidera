import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { isAbortError } from '../api/client';
import { labelText } from '../i18n/labelText';
import { WebGL2UnavailableError } from '../sky/engine/types';
import type { EngineTicker, SkyEngineApi, SkyEngineFactory } from '../sky/engine/types';
import { startBoot } from '../state/boot';
import type { FrameController } from '../state/frameController';
import type { SkyStore } from '../state/storeTypes';
import type { Backend } from '../state/types';

// The canvas the sky engine draws on (plan D87; brief l.406 "one engine instance created on
// mount and disposed on unmount", l.551 StrictMode). The component owns exactly one effect: it
// starts the boot sequence, creates the engine through the injected factory (unit tests hand in a
// fake, so Babylon never runs under jsdom) and disposes everything on unmount. No astronomy here:
// the engine reads the store through subscriptions and React never drives the canvas (l.409).
// Resizing is the engine's business as well: `SkyEngine` observes its own canvas (plan D85), so
// the component keeps no `ResizeObserver` of its own. The labels host is an `aria-hidden` sibling
// of the canvas handed to the engine with the text resolver (plan D93); React reaches the engine
// API only through `onEngine`, for event handlers such as the snapshot.

export interface SkyCanvasProps {
  store: SkyStore;
  frames: FrameController;
  createEngine: SkyEngineFactory;
  /** Pulled by the engine on every frame after the frame source (plan D93). */
  tickers?: readonly EngineTicker[] | undefined;
  /** The created engine, then `null` when it is torn down. */
  onEngine?: ((api: SkyEngineApi | null) => void) | undefined;
}

const NO_TICKERS: readonly EngineTicker[] = [];

/**
 * Dev and e2e builds only: `#engine=webgl2|webgpu` in the hash forces a backend so Playwright can
 * assert each shader path (plan D79, D89). The hash is never written into the query string.
 */
export function backendOverride(hash: string): Backend | 'auto' {
  const value = new URLSearchParams(hash.replace(/^#/, '')).get('engine');
  return value === 'webgl2' || value === 'webgpu' ? value : 'auto';
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

/** A promise settled from outside: `startBoot` waits on it while the factory runs (plan D87). */
function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

export default function SkyCanvas({
  store,
  frames,
  createEngine,
  tickers = NO_TICKERS,
  onEngine,
}: SkyCanvasProps) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelRootRef = useRef<HTMLDivElement>(null);
  // The latest callback, read by the engine effect without being one of its dependencies: a new
  // function identity on a parent re-render must not tear the GPU context down.
  const onEngineRef = useRef<SkyCanvasProps['onEngine']>(undefined);
  useEffect(() => {
    onEngineRef.current = onEngine;
  }, [onEngine]);
  // Same pattern for the tickers: the engine copies the list at construction, so a new array
  // identity (a parent writing `tickers={[x]}` inline) can never be honoured by re-creating it;
  // it would only abort the boot and tear the GPU context down.
  const tickersRef = useRef<readonly EngineTicker[]>(tickers);
  useEffect(() => {
    tickersRef.current = tickers;
  }, [tickers]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const labelRoot = labelRootRef.current;
    if (canvas === null || labelRoot === null) {
      return;
    }
    const controller = new AbortController();
    const { signal } = controller;
    // Read through a call: TypeScript narrows `signal.aborted` to `false` after one check and
    // keeps that across awaits, although the flag flips at any time.
    const aborted = (): boolean => signal.aborted;
    const { actions } = store.getState();
    // Vite folds both halves of this test away in production builds (`DEV` false, `MODE`
    // "production"), so the debug hook and its module never reach `make build` (plan D86).
    const debugBuild = import.meta.env.DEV || import.meta.env.MODE === 'e2e';
    let engine: SkyEngineApi | null = null;

    const start = async (): Promise<void> => {
      const engineReady = deferred<SkyEngineApi>();
      // The boot polls `/health` and loads the catalogs while the GPU context is created; it
      // waits on this promise only when it needs the engine (plan D87).
      const boot = startBoot({ store, frames, engine: engineReady.promise, signal });
      actions.setEngine({ status: 'creating' });
      try {
        const created = await createEngine({
          canvas,
          store,
          frames,
          labelRoot,
          labelText,
          tickers: tickersRef.current,
          signal,
          preferBackend: debugBuild ? backendOverride(location.hash) : 'auto',
          debug: debugBuild,
        });
        if (aborted()) {
          // A factory that ignores the signal still hands back a live context: release it.
          created.dispose();
          engineReady.reject(abortError());
          return;
        }
        engine = created;
        actions.setEngine({ kind: created.backend, status: 'running' });
        engineReady.resolve(created);
        onEngineRef.current?.(created);
        if (import.meta.env.DEV || import.meta.env.MODE === 'e2e') {
          // Same literal condition as above on purpose: a dynamic import under a folded `false`
          // is dropped by the bundler together with the module (brief l.410).
          const { installSkyDebug } = await import('../debug/skyDebug');
          if (!aborted()) {
            installSkyDebug({ store, engine: created, frames, catalog: boot.catalog, canvas });
          }
        }
      } catch (error) {
        engineReady.reject(error);
        if (aborted() || isAbortError(error)) {
          return;
        }
        actions.setEngine({ status: 'failed' });
        if (error instanceof WebGL2UnavailableError) {
          // Without a GPU context there is nothing left to boot: the boot would only meet the
          // rejected promise at its engine step, after `/health`, `/meta` and the catalog
          // download (or never, while the API is unreachable). Abort it first, so it returns
          // silently and writes nothing more, then show the UX-6 text at once.
          controller.abort();
          actions.setBoot({ phase: 'error', error: { kind: 'webgl2' } });
        }
      }
    };

    // Deferred by one microtask: in development React StrictMode runs effect, cleanup and effect
    // again synchronously (brief l.551), and the first pass is aborted before this task runs, so
    // exactly one boot and one engine are ever created.
    void Promise.resolve().then(() => (aborted() ? undefined : start()));

    return () => {
      // The engine listens to the signal and disposes itself; the explicit call covers a
      // factory that resolved without honouring it, and `dispose` is idempotent (so is `abort`,
      // already called when the factory threw `WebGL2UnavailableError`).
      controller.abort();
      engine?.dispose();
      onEngineRef.current?.(null);
    };
  }, [store, frames, createEngine]);

  return (
    <div className="absolute inset-0 overflow-hidden">
      <canvas ref={canvasRef} aria-label={t('canvas.label')} className="block h-full w-full" />
      <div
        aria-hidden="true"
        data-sky-labels
        className="pointer-events-none absolute inset-0 overflow-hidden [contain:strict]"
        ref={labelRootRef}
      />
    </div>
  );
}

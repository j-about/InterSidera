import { render, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';

import { labelText } from '../i18n/labelText';
import type {
  EngineTicker,
  SkyEngineApi,
  SkyEngineFactory,
  SkyEngineOptions,
} from '../sky/engine/types';
import { WebGL2UnavailableError } from '../sky/engine/types';
import type { FrameController } from '../state/frameController';
import { createSkyStore } from '../state/store';
import { createFrameEval } from '../state/types';
import SkyCanvas, { backendOverride } from './SkyCanvas';

// The single engine effect (plan D87, brief l.551): one factory call even under StrictMode's
// double effect, disposal on unmount, disposal of an engine that resolves after the abort, the
// `engine` slice of the store, the D93 seam (label host, text resolver, tickers, `onEngine`), the
// D121 AR underlay before the canvas and the dev/e2e hash override. Fetch hangs so the boot never
// reaches the network.

/** A fake engine plus its `dispose` spy, kept apart so the assertions never unbind a method. */
function fakeEngine(backend: 'webgl2' | 'webgpu' = 'webgl2'): {
  engine: SkyEngineApi;
  dispose: ReturnType<typeof vi.fn<() => void>>;
} {
  const dispose = vi.fn<() => void>();
  const engine: SkyEngineApi = {
    backend,
    adapterInfo: null,
    current: createFrameEval(1),
    underlayRoot: document.createElement('div'),
    setCatalog: () => undefined,
    currentTt: () => NaN,
    whenReady: () => new Promise<void>(() => undefined),
    fps: () => 0,
    frameMs: () => 0,
    starCount: () => 0,
    directionOf: () => false,
    readoutOf: () => false,
    pick: () => null,
    snapshot: () => Promise.reject(new Error('no snapshot in tests')),
    labelBoxes: () => [],
    skyBrightness: () => 0,
    layerStats: () => ({ dso: 0, clinesSegments: 0 }),
    reducedMotion: () => false,
    preloadXr: () => Promise.resolve(),
    enterXr: () => Promise.reject(new Error('no XR in tests')),
    exitXr: () => Promise.resolve(),
    arTransparent: () => false,
    resize: () => undefined,
    dispose: () => {
      dispose();
    },
  };
  return { engine, dispose };
}

function fakeFrames(): FrameController {
  return {
    update: () => undefined,
    evaluate: (_tt, out) => {
      out.valid = false;
    },
    whenCovering: () => new Promise<void>(() => undefined),
    dispose: () => undefined,
    state: {
      current: null,
      next: null,
      inFlight: null,
      lastSnapshotDoneMs: -Infinity,
      failedKey: null,
      failedShape: null,
    },
  };
}

/** A factory whose resolution the test controls. */
function controlledFactory(engine: SkyEngineApi) {
  let release: () => void = () => undefined;
  const calls: SkyEngineOptions[] = [];
  const factory: SkyEngineFactory = (options) => {
    calls.push(options);
    return new Promise<SkyEngineApi>((resolve) => {
      release = () => {
        resolve(engine);
      };
    });
  };
  return {
    factory,
    calls,
    release: () => {
      release();
    },
  };
}

describe('SkyCanvas', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined)),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete window.__sky;
  });

  it('creates exactly one engine under StrictMode and records it in the store', async () => {
    const store = createSkyStore();
    const { engine, dispose } = fakeEngine('webgpu');
    const factory = vi.fn<SkyEngineFactory>(() => Promise.resolve(engine));

    render(
      <StrictMode>
        <SkyCanvas store={store} frames={fakeFrames()} createEngine={factory} />
      </StrictMode>,
    );

    await waitFor(() => {
      expect(store.getState().engine).toEqual({ kind: 'webgpu', status: 'running' });
    });
    expect(factory).toHaveBeenCalledTimes(1);
    const options = factory.mock.calls[0]?.[0];
    expect(options?.canvas).toBeInstanceOf(HTMLCanvasElement);
    expect(options?.preferBackend).toBe('auto');
    expect(options?.signal.aborted).toBe(false);
    // The D93 seam: the label host is an `aria-hidden` sibling of the canvas, the text resolver
    // is the i18n one, and no ticker is handed over by default.
    expect(options?.labelRoot).toBeInstanceOf(HTMLElement);
    expect(options?.labelRoot.getAttribute('aria-hidden')).toBe('true');
    expect(options?.labelRoot.hasAttribute('data-sky-labels')).toBe(true);
    expect(options?.labelRoot.parentElement).toBe(options?.canvas.parentElement);
    expect(options?.labelText).toBe(labelText);
    expect(options?.tickers).toEqual([]);
    expect(dispose).not.toHaveBeenCalled();
    // Vitest runs as a dev build, so the debug hook is installed (plan D86). It lands after the
    // dynamic `import()` of `debug/skyDebug`, one or more ticks after `engine.status` flipped,
    // so the assertion waits (a plain `expect` here was flaky under a loaded machine).
    await waitFor(() => {
      expect(window.__sky?.backend).toBe('webgpu');
    });
  });

  it('disposes the engine and aborts the signal on unmount', async () => {
    const store = createSkyStore();
    const { engine, dispose } = fakeEngine();
    const factory = vi.fn<SkyEngineFactory>(() => Promise.resolve(engine));
    const view = render(<SkyCanvas store={store} frames={fakeFrames()} createEngine={factory} />);
    await waitFor(() => {
      expect(store.getState().engine.status).toBe('running');
    });

    view.unmount();

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(factory.mock.calls[0]?.[0].signal.aborted).toBe(true);
  });

  it('disposes an engine that resolves after the abort and leaves the store untouched', async () => {
    const store = createSkyStore();
    const { engine, dispose } = fakeEngine();
    const { factory, calls, release } = controlledFactory(engine);
    const view = render(<SkyCanvas store={store} frames={fakeFrames()} createEngine={factory} />);
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(store.getState().engine.status).toBe('creating');

    view.unmount();
    release();
    await waitFor(() => {
      expect(dispose).toHaveBeenCalledTimes(1);
    });

    expect(store.getState().engine).toEqual({ kind: null, status: 'creating' });
  });

  it('records a failed creation without touching an aborted one', async () => {
    const store = createSkyStore();
    const factory: SkyEngineFactory = () => Promise.reject(new WebGL2UnavailableError());
    render(<SkyCanvas store={store} frames={fakeFrames()} createEngine={factory} />);

    await waitFor(() => {
      expect(store.getState().engine.status).toBe('failed');
    });
    // The UX-6 text shows at once: `fetch` hangs here, so a boot left to discover the rejected
    // engine promise at its engine step (after `/health`, `/meta` and the catalogs) would still
    // be in `health`. The component aborts it and writes the `webgl2` error itself.
    expect(store.getState().boot).toMatchObject({ phase: 'error', error: { kind: 'webgl2' } });
  });

  it('hands the tickers to the factory and reports the engine through onEngine', async () => {
    const store = createSkyStore();
    const { engine } = fakeEngine();
    const factory = vi.fn<SkyEngineFactory>(() => Promise.resolve(engine));
    const tickers: EngineTicker[] = [{ update: () => undefined }];
    const frames = fakeFrames();
    const onEngine = vi.fn<(api: SkyEngineApi | null) => void>();
    const view = render(
      <SkyCanvas
        store={store}
        frames={frames}
        createEngine={factory}
        tickers={tickers}
        onEngine={onEngine}
      />,
    );
    await waitFor(() => {
      expect(onEngine).toHaveBeenCalledWith(engine);
    });
    expect(factory.mock.calls[0]?.[0].tickers).toBe(tickers);
    expect(onEngine).toHaveBeenCalledTimes(1);

    // A new callback identity does not recreate the engine, and the latest one hears the
    // teardown; neither does a new tickers array (a parent writing the list inline): the engine
    // copied the list at construction and a re-creation would only restart the boot.
    const replacement = vi.fn<(api: SkyEngineApi | null) => void>();
    view.rerender(
      <SkyCanvas
        store={store}
        frames={frames}
        createEngine={factory}
        tickers={[...tickers]}
        onEngine={replacement}
      />,
    );
    await Promise.resolve();
    expect(factory).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(replacement).toHaveBeenCalledTimes(1);
    expect(replacement).toHaveBeenLastCalledWith(null);
    expect(onEngine).toHaveBeenCalledTimes(1);
  });

  it('renders the AR underlay before the canvas and hands it to the factory (plan D121)', async () => {
    const store = createSkyStore();
    const { engine } = fakeEngine();
    const factory = vi.fn<SkyEngineFactory>(() => Promise.resolve(engine));
    render(<SkyCanvas store={store} frames={fakeFrames()} createEngine={factory} />);
    await waitFor(() => {
      expect(factory).toHaveBeenCalledTimes(1);
    });
    const options = factory.mock.calls[0]?.[0];
    if (options === undefined) {
      throw new Error('the factory received no options');
    }
    const { underlayRoot, canvas, labelRoot } = options;
    expect(underlayRoot).toBeInstanceOf(HTMLElement);
    expect(underlayRoot.getAttribute('aria-hidden')).toBe('true');
    expect(underlayRoot.hasAttribute('data-sky-underlay')).toBe(true);
    expect(underlayRoot.parentElement).toBe(canvas.parentElement);
    // DOM order: underlay, canvas, labels, so the video paints under the positioned canvas and
    // the labels over it.
    expect(underlayRoot.compareDocumentPosition(canvas) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(canvas.compareDocumentPosition(labelRoot) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(canvas.classList.contains('relative')).toBe(true);
    // React leaves the underlay empty: its contents belong to the AR controller.
    expect(underlayRoot.childElementCount).toBe(0);
  });

  it('labels the canvas for assistive technology', () => {
    const view = render(
      <SkyCanvas
        store={createSkyStore()}
        frames={fakeFrames()}
        createEngine={() => Promise.resolve(fakeEngine().engine)}
      />,
    );
    expect(view.getByLabelText('Sky view')).toBeInstanceOf(HTMLCanvasElement);
  });
});

describe('backendOverride', () => {
  it('reads the dev/e2e hash and ignores anything else', () => {
    expect(backendOverride('#engine=webgl2')).toBe('webgl2');
    expect(backendOverride('#engine=webgpu')).toBe('webgpu');
    expect(backendOverride('#engine=canvas')).toBe('auto');
    expect(backendOverride('#other=1')).toBe('auto');
    expect(backendOverride('')).toBe('auto');
  });
});

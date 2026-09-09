import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import App from './App';
import type { EngineTicker, SkyEngineApi, SkyEngineFactory } from './sky/engine/types';
import type { FrameController } from './state/frameController';
import { createSkyStore } from './state/store';
import { createFrameEval } from './state/types';

// The shell renders with a fake engine factory and a fake frame controller (plan D88): Babylon
// never runs under jsdom, and no request leaves (fetch is stubbed to hang, so the boot waits).
// Under jsdom `matchMedia` never matches: this is the phone layout (bottom sheet).

function fakeEngine(): SkyEngineApi {
  return {
    backend: 'webgl2',
    adapterInfo: null,
    current: createFrameEval(1),
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
    resize: () => undefined,
    dispose: () => undefined,
  };
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

describe('App', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined)),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the landmarks, the heading, the canvas, the stage and the named splash', () => {
    const createEngine: SkyEngineFactory = () => Promise.resolve(fakeEngine());
    render(<App store={createSkyStore()} frames={fakeFrames()} createEngine={createEngine} />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('InterSidera');
    expect(screen.getByRole('main')).toContainElement(screen.getByLabelText('Sky view'));
    expect(document.getElementById('sky-stage')).toContainElement(
      screen.getByLabelText('Sky view'),
    );
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Controls' })).toHaveAttribute('id', 'panel');
    expect(screen.getByRole('status', { name: 'Loading the sky' })).toHaveTextContent(
      'Connecting to the sky service',
    );
  });

  it('puts the skip link first and mounts the hint and the four tabs', () => {
    const store = createSkyStore();
    render(
      <App
        store={store}
        frames={fakeFrames()}
        createEngine={() => Promise.resolve(fakeEngine())}
      />,
    );
    const link = screen.getByRole('link', { name: 'Skip to the control panel' });
    expect(link).toHaveAttribute('href', '#panel');
    // Nothing focusable precedes it in the DOM.
    const focusables = document.querySelectorAll('a, button, input, select, textarea, [tabindex]');
    expect(focusables[0]).toBe(link);
    fireEvent.click(link);
    expect(screen.getByRole('complementary')).toHaveFocus();

    expect(screen.getByRole('status', { name: 'Getting started' })).toBeInTheDocument();
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Observer',
      'Time',
      'Layers',
      'Details',
    ]);
    expect(screen.getByRole('button', { name: 'About InterSidera' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Night vision' })).toBeInTheDocument();
  });

  it('threads the tickers and onEngine through to the canvas (plan D93)', async () => {
    const engine = fakeEngine();
    const createEngine = vi.fn<SkyEngineFactory>(() => Promise.resolve(engine));
    const tickers: EngineTicker[] = [{ update: () => undefined }];
    const onEngine = vi.fn<(api: SkyEngineApi | null) => void>();
    const view = render(
      <App
        store={createSkyStore()}
        frames={fakeFrames()}
        createEngine={createEngine}
        tickers={tickers}
        onEngine={onEngine}
      />,
    );
    await waitFor(() => {
      expect(onEngine).toHaveBeenCalledWith(engine);
    });
    expect(createEngine.mock.calls[0]?.[0].tickers).toBe(tickers);
    expect(createEngine.mock.calls[0]?.[0].labelRoot.hasAttribute('data-sky-labels')).toBe(true);
    view.unmount();
    expect(onEngine).toHaveBeenLastCalledWith(null);
  });
});

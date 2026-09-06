import { render, screen } from '@testing-library/react';

import App from './App';
import type { SkyEngineApi, SkyEngineFactory } from './sky/engine/types';
import type { FrameController } from './state/frameController';
import { createSkyStore } from './state/store';
import { createFrameEval } from './state/types';

// The shell renders with a fake engine factory and a fake frame controller (plan D88): Babylon
// never runs under jsdom, and no request leaves (fetch is stubbed to hang, so the boot waits).

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

  it('renders the product name as the level-1 heading, the canvas and the splash', () => {
    const createEngine: SkyEngineFactory = () => Promise.resolve(fakeEngine());
    render(<App store={createSkyStore()} frames={fakeFrames()} createEngine={createEngine} />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('InterSidera');
    expect(screen.getByLabelText('Sky view')).toBeInstanceOf(HTMLCanvasElement);
    expect(screen.getByRole('status')).toHaveTextContent('Connecting to the sky service');
  });
});

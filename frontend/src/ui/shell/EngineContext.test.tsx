import { render, screen } from '@testing-library/react';

import type { SkyEngineApi } from '../../sky/engine/types';
import { createFrameEval } from '../../state/types';
import { EngineProvider, useEngine } from './EngineContext';

function Probe() {
  const engine = useEngine();
  return <p>{engine === null ? 'none' : engine.backend}</p>;
}

describe('EngineContext', () => {
  it('is null without a provider and hands the engine down otherwise', () => {
    const engine: SkyEngineApi = {
      backend: 'webgpu',
      adapterInfo: null,
      current: createFrameEval(1),
      setCatalog: () => undefined,
      currentTt: () => NaN,
      whenReady: () => Promise.resolve(),
      fps: () => 0,
      frameMs: () => 0,
      starCount: () => 0,
      directionOf: () => false,
      readoutOf: () => false,
      pick: () => null,
      snapshot: () => Promise.reject(new Error('no')),
      labelBoxes: () => [],
      skyBrightness: () => 0,
      layerStats: () => ({ dso: 0, clinesSegments: 0 }),
      reducedMotion: () => false,
      resize: () => undefined,
      dispose: () => undefined,
    };
    const view = render(<Probe />);
    expect(screen.getByText('none')).toBeInTheDocument();
    view.rerender(
      <EngineProvider engine={engine}>
        <Probe />
      </EngineProvider>,
    );
    expect(screen.getByText('webgpu')).toBeInTheDocument();
    view.rerender(
      <EngineProvider engine={null}>
        <Probe />
      </EngineProvider>,
    );
    expect(screen.getByText('none')).toBeInTheDocument();
  });
});

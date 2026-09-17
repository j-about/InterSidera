import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { SkyEngineApi } from '../../sky/engine/types';
import { createSkyStore } from '../../state/store';
import { createFrameEval } from '../../state/types';
import { EngineProvider } from './EngineContext';
import ExportButton, { downloadBlob, snapshotFilename } from './ExportButton';

/**
 * A `URL` stand-in with object-URL statics (jsdom has none): a subclass, so `unstubAllGlobals`
 * restores the untouched original instead of leaving spies on the real constructor.
 */
function stubObjectUrls(url: string) {
  const createObjectURL = vi.fn(() => url);
  const revokeObjectURL = vi.fn(() => undefined);
  class StubURL extends URL {
    static override createObjectURL = createObjectURL;
    static override revokeObjectURL = revokeObjectURL;
  }
  vi.stubGlobal('URL', StubURL);
  return { createObjectURL, revokeObjectURL };
}

function fakeEngine(snapshot: () => Promise<Blob>): SkyEngineApi {
  return {
    backend: 'webgl2',
    adapterInfo: null,
    current: createFrameEval(1),
    underlayRoot: document.createElement('div'),
    setCatalog: () => undefined,
    currentTt: () => NaN,
    whenReady: () => Promise.resolve(),
    fps: () => 0,
    frameMs: () => 0,
    starCount: () => 0,
    directionOf: () => false,
    readoutOf: () => false,
    pick: () => null,
    snapshot,
    labelBoxes: () => [],
    skyBrightness: () => 0,
    layerStats: () => ({ dso: 0, clinesSegments: 0 }),
    reducedMotion: () => false,
    preloadXr: () => Promise.resolve(),
    enterXr: () => Promise.reject(new Error('no XR in tests')),
    exitXr: () => Promise.resolve(),
    arTransparent: () => false,
    resize: () => undefined,
    dispose: () => undefined,
  };
}

describe('snapshotFilename', () => {
  it('drops colons and milliseconds from the UTC ISO string', () => {
    expect(snapshotFilename('2026-09-09T15:14:03.123Z')).toBe('intersidera-2026-09-09T151403Z.png');
    expect(snapshotFilename('2026-09-09T15:14:03Z')).toBe('intersidera-2026-09-09T151403Z.png');
  });
});

describe('downloadBlob', () => {
  it('clicks a hidden anchor on an object URL and revokes it afterwards', () => {
    vi.useFakeTimers();
    const { revokeObjectURL } = stubObjectUrls('blob:test');
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      expect(this.href).toBe('blob:test');
      expect(this.download).toBe('x.png');
      expect(this.isConnected).toBe(true);
    });
    try {
      downloadBlob(new Blob(['png']), 'x.png');
      expect(click).toHaveBeenCalledTimes(1);
      expect(document.querySelector('a[download]')).toBeNull();
      expect(revokeObjectURL).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1000);
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:test');
    } finally {
      click.mockRestore();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});

describe('ExportButton', () => {
  it('downloads the engine snapshot as a PNG named after the moment', async () => {
    const store = createSkyStore();
    const blob = new Blob(['png'], { type: 'image/png' });
    const engine = fakeEngine(() => Promise.resolve(blob));
    // The rendered instant, not the wall clock: 2024-04-08T18:00 TT, TT - UTC = 69.184 s.
    store.setState((s) => ({ clock: { ...s.clock, tt: 2460409.25, ttMinusUtc: 69.184 } }));
    const { createObjectURL } = stubObjectUrls('blob:snap');
    const names: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      names.push(this.download);
    });
    try {
      render(
        <EngineProvider engine={engine}>
          <ExportButton store={store} />
        </EngineProvider>,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Export the view as PNG' }));
      await waitFor(() => {
        expect(click).toHaveBeenCalledTimes(1);
      });
      expect(createObjectURL).toHaveBeenCalledWith(blob);
      expect(names[0]).toBe('intersidera-2024-04-08T175851Z.png');
      expect(screen.queryByRole('alert')).toBeNull();
      expect(store.getState().ui.toast).toBeNull();
    } finally {
      click.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('reports the failure through the toast when the snapshot rejects', async () => {
    const store = createSkyStore();
    const engine = fakeEngine(() => Promise.reject(new Error('not implemented')));
    render(
      <EngineProvider engine={engine}>
        <ExportButton store={store} />
      </EngineProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Export the view as PNG' }));
    await waitFor(() => {
      expect(store.getState().ui.toast?.key).toBe('export.failed');
    });
    // The toast region (C) is the single home of the message: no second inline alert.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('fails at once without an engine', () => {
    const store = createSkyStore();
    render(<ExportButton store={store} />);
    fireEvent.click(screen.getByRole('button', { name: 'Export the view as PNG' }));
    expect(store.getState().ui.toast?.key).toBe('export.failed');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

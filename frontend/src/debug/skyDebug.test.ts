// The debug hook under jsdom (plan D141): the Performance Timeline parts answer empty where the
// platform lacks them instead of throwing (vitest's jsdom exposes Node's `performance`, with marks
// and `getEntriesByType`, but declares no `PerformanceNavigationTiming`, like a bare jsdom
// window), the `NO_PERF` fallback answers zeros for a fake engine without `perf`, and
// `afterFrames` settles at once. Babylon never runs here: the engine is the fake shape of the
// boot tests.

import { installSkyDebug } from './skyDebug';
import type { SkyDebugApi } from './skyDebugApi';
import type { FrameSource, SkyEngineApi } from '../sky/engine/types';
import { createSkyStore } from '../state/store';
import { createFrameEval } from '../state/types';

const NOW = 1_700_000_000_000;

function fakeEngine(): SkyEngineApi {
  return {
    backend: 'webgl2',
    adapterInfo: null,
    current: createFrameEval(0),
    underlayRoot: document.createElement('div'),
    setCatalog: () => undefined,
    currentTt: () => 0,
    whenReady: () => Promise.resolve(),
    fps: () => 60,
    frameMs: () => 1,
    starCount: () => 0,
    directionOf: () => false,
    readoutOf: () => false,
    pick: () => null,
    snapshot: () => Promise.reject(new Error('no snapshot in tests')),
    preloadXr: () => Promise.resolve(),
    enterXr: () => Promise.resolve(),
    exitXr: () => Promise.resolve(),
    arTransparent: () => false,
    labelBoxes: () => [],
    skyBrightness: () => 0,
    layerStats: () => ({ dso: 3, clinesSegments: 7 }),
    reducedMotion: () => false,
    resize: () => undefined,
    dispose: () => undefined,
  };
}

const frames: FrameSource = {
  update: () => undefined,
  evaluate: () => undefined,
  whenCovering: () => Promise.resolve(),
};

function install(): SkyDebugApi {
  return installSkyDebug({
    store: createSkyStore({}, NOW),
    engine: fakeEngine(),
    frames,
    catalog: () => null,
    canvas: document.createElement('canvas'),
  });
}

describe('installSkyDebug under jsdom', () => {
  beforeEach(() => {
    performance.clearMarks();
  });
  afterEach(() => {
    performance.clearMarks();
    vi.restoreAllMocks();
    delete window.__sky;
  });

  it('answers empty timing and resources without the Performance Timeline classes', () => {
    const api = install();
    expect(window.__sky).toBe(api);
    expect(typeof PerformanceNavigationTiming).toBe('undefined');
    const timing = api.timing();
    expect(typeof timing.timeOrigin).toBe('number');
    expect(timing.marks).toEqual({});
    expect(timing.navigation).toBeNull();
    expect(api.resources()).toEqual([]);
  });

  it('reports the sky:* marks by name, the last occurrence of a repeated mark winning', () => {
    const api = install();
    performance.mark('sky:health');
    performance.mark('other');
    performance.mark('sky:health');
    const { marks } = api.timing();
    expect(Object.keys(marks)).toEqual(['sky:health']);
    const entries = performance.getEntriesByName('sky:health');
    expect(entries).toHaveLength(2);
    expect(marks['sky:health']).toBe(entries[1]?.startTime);
  });

  it('asks for a larger Resource Timing buffer where the platform has the setter', () => {
    const setter = vi.spyOn(performance, 'setResourceTimingBufferSize');
    install();
    expect(setter).toHaveBeenCalledWith(1000);
  });

  it('falls back to NO_PERF for an engine without perf and settles afterFrames at once', async () => {
    const api = install();
    expect(api.state().tickWallMs).toBeNaN();
    expect(api.stats()).toMatchObject({
      dso: 3,
      clinesSegments: 7,
      clinesHighlight: null,
      cboundsSegments: 0,
      frames: 0,
      overlayTicks: 0,
      labelPublishes: 0,
      tickMs: 0,
      renderMs: 0,
      overlayMs: 0,
      renderWidth: 0,
      renderHeight: 0,
    });
    await expect(api.afterFrames(5)).resolves.toBeUndefined();
  });
});

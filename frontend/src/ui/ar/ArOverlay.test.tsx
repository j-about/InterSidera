import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { SkyEngineApi } from '../../sky/engine/types';
import { createSkyStore } from '../../state/store';
import { createFrameEval } from '../../state/types';
import type { ArCapabilities } from '../../state/types';
import { EngineProvider } from '../shell/EngineContext';
import ArOverlay, { AR_OVERLAY_ID } from './ArOverlay';

// The AR chrome (AR-1..AR-5, plan D127): the requesting banner with its cancel, the exit control
// focused on entry, the offset readout and reset, the camera-field slider, the atmosphere switch,
// the WebXR switch and the transport in a session, the manual-north hint, the mode status line.
// Roles, names and store writes are asserted, never markup.

const CAPABLE: ArCapabilities = {
  secure: true,
  camera: true,
  orientation: true,
  touch: true,
  videoInput: true,
};

/** A fake engine whose XR seam is observable: the mocks are returned beside it (plan D93, D128). */
function fakeEngine() {
  const enterXr = vi.fn<(overlay: HTMLElement) => Promise<void>>(() => Promise.resolve());
  const exitXr = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const engine: SkyEngineApi = {
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
    snapshot: () => Promise.reject(new Error('no snapshot in tests')),
    labelBoxes: () => [],
    skyBrightness: () => 0,
    layerStats: () => ({ dso: 0, clinesSegments: 0 }),
    reducedMotion: () => false,
    preloadXr: () => Promise.resolve(),
    enterXr,
    exitXr,
    arTransparent: () => true,
    resize: () => undefined,
    dispose: () => undefined,
  };
  return { engine, enterXr, exitXr };
}

/** A store in the sensor mode (or still requesting), as the button and the controller leave it. */
function arStore(mode: 'requesting' | 'sensor' | 'xr' = 'sensor') {
  const store = createSkyStore();
  const { actions } = store.getState();
  actions.setArCapabilities(CAPABLE);
  actions.setArPermission('granted');
  actions.requestAr();
  if (mode !== 'requesting') {
    actions.setArMode('sensor');
  }
  if (mode === 'xr') {
    actions.setArMode('xr');
  }
  return store;
}

function renderOverlay(store: ReturnType<typeof arStore>, engine: SkyEngineApi | null = null) {
  return render(
    <EngineProvider engine={engine}>
      <ArOverlay store={store} />
    </EngineProvider>,
  );
}

describe('ArOverlay', () => {
  it('is the banner landmark, focuses the exit control on entry and exits through the store', () => {
    const store = arStore();
    renderOverlay(store);
    const banner = screen.getByRole('banner');
    expect(banner).toHaveAttribute('id', AR_OVERLAY_ID);
    const exit = screen.getByRole('button', { name: 'Exit augmented reality' });
    expect(exit).toHaveFocus();
    expect(screen.getByRole('status', { name: 'Augmented reality status' })).toHaveTextContent(
      'Augmented reality on',
    );
    for (const button of screen.getAllByRole('button')) {
      expect(button).toHaveAccessibleName();
    }
    fireEvent.click(exit);
    expect(store.getState().ar.mode).toBe('off');
  });

  it('explains the browser prompts while requesting, with a cancel button', () => {
    const store = arStore('requesting');
    renderOverlay(store);
    const status = screen.getByRole('status', { name: 'Starting augmented reality' });
    expect(status).toHaveTextContent('Allow the camera and the motion sensors');
    expect(screen.queryByRole('slider')).toBeNull();
    expect(screen.queryByRole('status', { name: 'Augmented reality status' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Exit augmented reality' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(store.getState().ar.mode).toBe('off');
  });

  it('shows the offset with its reset, the camera-field slider and the atmosphere switch', () => {
    const store = arStore();
    const { actions } = store.getState();
    act(() => {
      actions.setArOffset(12.4);
    });
    renderOverlay(store);
    expect(screen.getByText('Azimuth offset 12°')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reset the alignment' }));
    expect(store.getState().ar.azOffsetDeg).toBe(0);
    expect(screen.getByText('Azimuth offset 0°')).toBeInTheDocument();

    const slider = screen.getByRole('slider', { name: 'Camera field of view' });
    expect(slider).toHaveValue('73');
    expect(slider).toHaveAttribute('aria-valuetext', '73°');
    fireEvent.change(slider, { target: { value: '60' } });
    expect(store.getState().ar.cameraFovDeg).toBe(60);
    expect(slider).toHaveAttribute('aria-valuetext', '60°');

    const atmosphere = screen.getByRole('switch', { name: 'Atmosphere and daylight' });
    const before = store.getState().options.atm;
    fireEvent.click(atmosphere);
    expect(store.getState().options.atm).toBe(!before);
  });

  it('shows the hint for an absent or relative heading, worded per level, until dismissed', () => {
    const store = arStore();
    const { actions } = store.getState();
    renderOverlay(store);
    // `none` before the first sample: the hint is up with the waiting text, never the manual one
    // (the compass badge beside it reads "Waiting for the sensors"; the two must agree).
    const hint = screen.getByRole('status', { name: 'Align the sky' });
    expect(hint).toHaveTextContent('Waiting for the motion sensors');
    expect(hint).not.toHaveTextContent('No compass on this device');
    act(() => {
      actions.setArHeading({ source: 'absolute', accuracyDeg: null, level: 'good' });
    });
    expect(screen.queryByRole('status', { name: 'Align the sky' })).toBeNull();
    act(() => {
      actions.setArHeading({ source: 'relative', accuracyDeg: null, level: 'manual' });
    });
    expect(screen.getByRole('status', { name: 'Align the sky' })).toHaveTextContent(
      'No compass on this device: point the phone north',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(store.getState().ar.hintDismissed).toBe(true);
    expect(screen.queryByRole('status', { name: 'Align the sky' })).toBeNull();
  });

  it('offers the immersive mode only when the probe said supported and enters it through the engine', () => {
    const store = arStore();
    const { actions } = store.getState();
    const { engine, enterXr } = fakeEngine();
    renderOverlay(store, engine);
    expect(screen.queryByRole('button', { name: 'Immersive mode (WebXR)' })).toBeNull();
    act(() => {
      actions.setArXr({ support: 'supported' });
    });
    const enter = screen.getByRole('button', { name: 'Immersive mode (WebXR)' });
    fireEvent.click(enter);
    expect(enterXr).toHaveBeenCalledTimes(1);
    // The DOM-overlay root handed to the session is the header itself (plan D128).
    expect(enterXr.mock.calls[0]?.[0]).toBe(screen.getByRole('banner'));
    act(() => {
      actions.setArXr({ phase: 'entering' });
    });
    expect(enter).toBeDisabled();
  });

  it('in a session shows the leave button and the transport, and exits through exitXr then exitAr', async () => {
    const store = arStore('xr');
    const { engine, exitXr } = fakeEngine();
    renderOverlay(store, engine);
    expect(screen.getByRole('status', { name: 'Augmented reality status' })).toHaveTextContent(
      'Immersive augmented reality on',
    );
    expect(screen.queryByRole('button', { name: 'Immersive mode (WebXR)' })).toBeNull();
    expect(screen.getByRole('group', { name: 'Speed' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Leave the immersive mode' }));
    expect(exitXr).toHaveBeenCalledTimes(1);
    expect(store.getState().ar.mode).toBe('xr');

    fireEvent.click(screen.getByRole('button', { name: 'Exit augmented reality' }));
    expect(exitXr).toHaveBeenCalledTimes(2);
    await waitFor(() => {
      expect(store.getState().ar.mode).toBe('off');
    });
  });

  it('exits AR even when the session refuses to end', async () => {
    const store = arStore('xr');
    const { engine, exitXr } = fakeEngine();
    exitXr.mockImplementation(() => Promise.reject(new Error('stuck')));
    renderOverlay(store, engine);
    fireEvent.click(screen.getByRole('button', { name: 'Exit augmented reality' }));
    await waitFor(() => {
      expect(store.getState().ar.mode).toBe('off');
    });
  });
});

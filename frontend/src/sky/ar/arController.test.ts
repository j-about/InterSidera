import type { Mock, MockInstance } from 'vitest';

import { createSkyStore } from '../../state/store';
import type { SkyActions, SkyStore } from '../../state/storeTypes';
import type { Backend, XrSupport } from '../../state/types';
import type { ArController, ArHost } from '../engine/types';
import { STALE_SAMPLE_MS } from '../math/orientation';
import { ABSOLUTE_HOLD_MS, createArController } from './arController';
import type { ArControllerDeps } from './arController';
import { CameraVideoFailure } from './cameraVideo';
import type { CameraVideo, CameraVideoError, startCameraVideo } from './cameraVideo';
import type {
  OrientationSample,
  OrientationSensorOptions,
  startOrientationSensors,
} from './sensors';

// The sensor-mode controller of plan D116 against the real store under jsdom with a fake camera,
// fake sensors and a fake XR probe: the permission gate, the camera failure codes, the frame size,
// the two ways the video ends (and an end replayed before the handle is used), the heading
// sources and the D118 offset rules, one `setArPose`
// per update converging on the fixture pose (alpha 270, beta 90, gamma 0 -> az 90, alt 0, roll 0),
// the staleness rule on the engine clock, the XR pause, the camera lost to an XR session or its
// entry and reacquired afterwards (R94) and the idempotent dispose.

const T0 = 1_757_000_000_000;
const TT = 2460409.25;

interface FakeCamera {
  cam: CameraVideo;
  stop: Mock<() => void>;
  emitSize(width: number, height: number): void;
  end(reason: 'trackEnded' | 'hidden'): void;
}

/** `ended` mimics a handle whose session ended before it was returned: `onEnded` replays it. */
function fakeCamera(ended: 'trackEnded' | 'hidden' | null = null): FakeCamera {
  const sizeListeners = new Set<(w: number, h: number) => void>();
  const endListeners = new Set<(reason: 'trackEnded' | 'hidden') => void>();
  const stop = vi.fn<() => void>();
  const video = document.createElement('video');
  return {
    cam: {
      video,
      facingMode: 'environment',
      onFrameSize(listener) {
        sizeListeners.add(listener);
        return () => sizeListeners.delete(listener);
      },
      onEnded(listener) {
        if (ended !== null) {
          listener(ended);
          return () => undefined;
        }
        endListeners.add(listener);
        return () => endListeners.delete(listener);
      },
      onMuted() {
        return () => undefined;
      },
      stop,
    },
    stop,
    emitSize(width, height) {
      for (const l of sizeListeners) {
        l(width, height);
      }
    },
    end(reason) {
      stop();
      for (const l of endListeners) {
        l(reason);
      }
    },
  };
}

interface Rig {
  store: SkyStore;
  host: ArHost;
  camera: FakeCamera;
  startCameraVideo: Mock<typeof startCameraVideo>;
  sensorsStop: Mock<() => void>;
  startSensors: Mock<typeof startOrientationSensors>;
  push(sample: Partial<OrientationSample> & { atMs: number }): void;
  preloadXr: Mock<() => Promise<void>>;
  probeXr: Mock<(xr: unknown, backend: Backend | null) => Promise<XrSupport>>;
  setArPose: MockInstance<SkyActions['setArPose']>;
  create(deps?: Partial<ArControllerDeps>): ArController;
}

function settle(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

function rig(
  options: {
    cameraFailure?: CameraVideoError;
    cameraEnded?: 'trackEnded' | 'hidden';
    xr?: XrSupport;
  } = {},
): Rig {
  const store = createSkyStore({ t: TT, speed: 0, az: 200, alt: 10, fov: 60 }, T0);
  const camera = fakeCamera(options.cameraEnded ?? null);
  const startCamera = vi.fn<typeof startCameraVideo>();
  startCamera.mockImplementation(() =>
    options.cameraFailure === undefined
      ? Promise.resolve(camera.cam)
      : Promise.reject(new CameraVideoFailure(options.cameraFailure)),
  );
  let onSample: ((sample: Readonly<OrientationSample>) => void) | null = null;
  const sensorsStop = vi.fn<() => void>();
  const startSensors = vi.fn<typeof startOrientationSensors>();
  startSensors.mockImplementation((sensorOptions: OrientationSensorOptions) => {
    onSample = (sample) => {
      sensorOptions.onSample(sample);
    };
    return { stop: sensorsStop };
  });
  const preloadXr = vi.fn(() => Promise.resolve());
  const probeXr = vi.fn<(xr: unknown, backend: Backend | null) => Promise<XrSupport>>();
  probeXr.mockImplementation(() => Promise.resolve(options.xr ?? 'unsupported'));
  const underlayRoot = document.createElement('div');
  const setArPose = vi.spyOn(store.getState().actions, 'setArPose');
  const host: ArHost = { store, underlayRoot, preloadXr };
  return {
    store,
    host,
    camera,
    startCameraVideo: startCamera,
    sensorsStop,
    startSensors,
    push(sample) {
      if (onSample === null) {
        throw new Error('sensors not started');
      }
      onSample({
        alpha: 0,
        beta: 0,
        gamma: 0,
        absolute: false,
        compassHeading: NaN,
        compassAccuracy: NaN,
        screenAngle: 0,
        ...sample,
      });
    },
    preloadXr,
    probeXr,
    setArPose,
    create(deps = {}) {
      return createArController(host, {
        startCameraVideo: startCamera,
        startOrientationSensors: startSensors,
        probeXr,
        mediaDevices: undefined,
        now: () => T0,
        ...deps,
      });
    },
  };
}

/** Enter through the store like the button does: `requestAr` then the permission outcome. */
function enter(
  r: Rig,
  permission: 'granted' | 'prompt' | 'notRequired' | 'denied' = 'granted',
): void {
  const { actions } = r.store.getState();
  actions.requestAr();
  actions.setArPermission(permission);
}

/** Drive the engine clock until the smoothing converges or `frames` ran out; returns the last time. */
function drive(controller: ArController, fromMs: number, frames: number, stepMs = 16): number {
  let now = fromMs;
  for (let k = 0; k < frames; k += 1) {
    now += stepMs;
    controller.update(TT, now);
  }
  return now;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createArController', () => {
  it('waits for the permission and fails with orientationDenied when it is refused', async () => {
    const r = rig();
    r.store.getState().actions.requestAr();
    r.store.getState().actions.setArPermission('pending');
    const controller = r.create();
    await settle();
    expect(r.startCameraVideo).not.toHaveBeenCalled();
    r.store.getState().actions.setArPermission('denied');
    await settle();
    expect(r.startCameraVideo).not.toHaveBeenCalled();
    expect(r.store.getState().ar).toMatchObject({ mode: 'off', error: 'orientationDenied' });
    controller.dispose();
  });

  it.each(['granted', 'prompt', 'notRequired'] as const)(
    'proceeds on %s: camera in the underlay, sensors, sensor mode, XR probe',
    async (permission) => {
      const r = rig();
      enter(r, permission);
      const controller = r.create();
      await settle();
      expect(r.startCameraVideo).toHaveBeenCalledTimes(1);
      expect(r.startCameraVideo.mock.calls[0]?.[0]).toBe(r.host.underlayRoot);
      expect(r.startCameraVideo.mock.calls[0]?.[1]).toMatchObject({ mediaDevices: undefined });
      expect(r.startSensors).toHaveBeenCalledTimes(1);
      expect(r.startSensors.mock.calls[0]?.[0].now?.()).toBe(T0);
      expect(r.store.getState().ar.mode).toBe('sensor');
      expect(r.probeXr).toHaveBeenCalledWith(undefined, null);
      expect(r.store.getState().ar.xr.support).toBe('unsupported');
      expect(r.preloadXr).not.toHaveBeenCalled();
      expect(controller.video()).toBe(r.camera.cam.video);
      controller.dispose();
    },
  );

  it('preloads the WebXR chunk when the probe reports support', async () => {
    const r = rig({ xr: 'supported' });
    enter(r);
    const controller = r.create();
    await settle();
    expect(r.store.getState().ar.xr.support).toBe('supported');
    expect(r.preloadXr).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it.each(['noCamera', 'noRearCamera', 'cameraDenied', 'cameraUnavailable'] as const)(
    'propagates the camera failure %s and leaves AR',
    async (code) => {
      const r = rig({ cameraFailure: code });
      enter(r);
      const controller = r.create();
      await settle();
      expect(r.store.getState().ar).toMatchObject({ mode: 'off', error: code });
      expect(r.startSensors).not.toHaveBeenCalled();
      expect(controller.video()).toBeNull();
      controller.dispose();
    },
  );

  it('reads an unknown camera rejection as cameraUnavailable', async () => {
    const r = rig();
    enter(r);
    const controller = r.create({
      startCameraVideo: () => Promise.reject(new Error('boom')),
    });
    await settle();
    expect(r.store.getState().ar).toMatchObject({ mode: 'off', error: 'cameraUnavailable' });
    controller.dispose();
  });

  it('publishes the frame size, exits silently when hidden and fails on a track that ended', async () => {
    const r = rig();
    enter(r);
    const controller = r.create();
    await settle();
    r.camera.emitSize(1280, 720);
    expect(r.store.getState().ar.frame).toEqual({ width: 1280, height: 720 });
    r.camera.end('hidden');
    expect(r.store.getState().ar).toMatchObject({ mode: 'off', error: null, frame: null });
    controller.dispose();

    const t = rig();
    enter(t);
    const second = t.create();
    await settle();
    t.camera.end('trackEnded');
    expect(t.store.getState().ar).toMatchObject({ mode: 'off', error: 'trackEnded' });
    second.dispose();
  });

  it.each(['hidden', 'trackEnded'] as const)(
    'a camera that ended before the handle returned (%s) leaves AR without starting the sensors',
    async (reason) => {
      const r = rig({ cameraEnded: reason });
      enter(r);
      // The engine's half of the contract: `off` disposes the controller synchronously.
      let controller: ArController | null = null;
      const off = r.store.subscribe(
        (s) => s.ar.mode,
        (mode) => {
          if (mode === 'off') {
            controller?.dispose();
          }
        },
      );
      controller = r.create();
      await settle();
      expect(r.startCameraVideo).toHaveBeenCalledTimes(1);
      expect(r.store.getState().ar).toMatchObject({
        mode: 'off',
        error: reason === 'hidden' ? null : 'trackEnded',
        frame: null,
      });
      expect(r.startSensors).not.toHaveBeenCalled();
      expect(r.camera.stop).toHaveBeenCalledTimes(1);
      expect(controller.video()).toBeNull();
      // The frame listener was never registered: a size arriving now changes nothing.
      r.camera.emitSize(1280, 720);
      controller.update(TT, T0 + 16);
      expect(r.store.getState().ar.frame).toBeNull();
      expect(r.setArPose).not.toHaveBeenCalled();
      off();
    },
  );

  it('converges on the fixture pose with one setArPose per update and an absolute heading', async () => {
    const r = rig();
    enter(r);
    const controller = r.create();
    await settle();
    r.setArPose.mockClear();
    // No sample yet: nothing is written.
    controller.update(TT, T0 + 16);
    expect(r.setArPose).not.toHaveBeenCalled();
    r.push({ alpha: 270, beta: 90, gamma: 0, absolute: true, atMs: T0 + 20 });
    controller.update(TT, T0 + 32);
    expect(r.setArPose).toHaveBeenCalledTimes(1);
    expect(r.store.getState().ar.heading).toEqual({
      source: 'absolute',
      accuracyDeg: null,
      level: 'good',
    });
    expect(r.store.getState().ar.azOffsetDeg).toBe(0);
    // The first sample snaps (no previous pose): the view is the fixture pose at once.
    expect(r.store.getState().view.az).toBeCloseTo(90, 6);
    expect(r.store.getState().view.alt).toBeCloseTo(0, 6);
    expect(r.store.getState().ar.roll).toBeCloseTo(0, 6);
    // A second triple moves the mirror through the smoothing: one write per update, converging.
    r.push({ alpha: 180, beta: 90, gamma: 0, absolute: true, atMs: T0 + 40 });
    controller.update(TT, T0 + 48);
    expect(r.setArPose).toHaveBeenCalledTimes(2);
    const partial = r.store.getState().view.az;
    expect(partial).toBeGreaterThan(90);
    expect(partial).toBeLessThan(180);
    const end = drive(controller, T0 + 48, 120);
    expect(r.store.getState().view.az).toBeCloseTo(180, 2);
    const writes = r.setArPose.mock.calls.length;
    // Converged and no new sample: nothing more is written.
    controller.update(TT, end + 16);
    controller.update(TT, end + 32);
    expect(r.setArPose).toHaveBeenCalledTimes(writes);
    // A drag moves the offset: the pose is re-published once with it.
    r.store.getState().actions.nudgeArOffset(10);
    controller.update(TT, end + 48);
    expect(r.setArPose).toHaveBeenCalledTimes(writes + 1);
    expect(r.store.getState().view.az).toBeCloseTo(190, 2);
    controller.dispose();
  });

  it('keeps the previous direction on a relative entry and resets the offset once on an upgrade', async () => {
    const r = rig();
    enter(r);
    const controller = r.create();
    await settle();
    // Relative sample looking at az 90 while the user was looking at az 200.
    r.push({ alpha: 270, beta: 90, gamma: 0, absolute: false, atMs: T0 + 20 });
    controller.update(TT, T0 + 32);
    expect(r.store.getState().ar.heading).toEqual({
      source: 'relative',
      accuracyDeg: null,
      level: 'manual',
    });
    expect(r.store.getState().ar.azOffsetDeg).toBeCloseTo(110, 6);
    expect(r.store.getState().view.az).toBeCloseTo(200, 6);
    // A second relative sample keeps the offset.
    r.push({ alpha: 271, beta: 90, gamma: 0, absolute: false, atMs: T0 + 40 });
    controller.update(TT, T0 + 48);
    expect(r.store.getState().ar.azOffsetDeg).toBeCloseTo(110, 6);
    // The upgrade to an absolute source resets the offset to 0 once.
    r.push({ alpha: 270, beta: 90, gamma: 0, absolute: true, atMs: T0 + 60 });
    controller.update(TT, T0 + 64);
    expect(r.store.getState().ar.heading.source).toBe('absolute');
    expect(r.store.getState().ar.azOffsetDeg).toBe(0);
    // A downgrade keeps the last correction; a second upgrade does not reset again.
    r.store.getState().actions.setArOffset(-20);
    r.push({ alpha: 270, beta: 90, gamma: 0, absolute: false, atMs: T0 + 60 + ABSOLUTE_HOLD_MS });
    controller.update(TT, T0 + 64 + ABSOLUTE_HOLD_MS);
    expect(r.store.getState().ar.heading.source).toBe('relative');
    expect(r.store.getState().ar.azOffsetDeg).toBe(-20);
    r.push({ alpha: 270, beta: 90, gamma: 0, absolute: true, atMs: T0 + 80 + ABSOLUTE_HOLD_MS });
    controller.update(TT, T0 + 96 + ABSOLUTE_HOLD_MS);
    expect(r.store.getState().ar.heading.source).toBe('absolute');
    expect(r.store.getState().ar.azOffsetDeg).toBe(-20);
    controller.dispose();
  });

  it('drops relative samples for one second after an absolute one', async () => {
    const r = rig();
    enter(r);
    const controller = r.create();
    await settle();
    r.push({ alpha: 270, beta: 90, gamma: 0, absolute: true, atMs: T0 + 20 });
    controller.update(TT, T0 + 32);
    r.push({ alpha: 0, beta: 90, gamma: 0, absolute: false, atMs: T0 + 20 + ABSOLUTE_HOLD_MS - 1 });
    drive(controller, T0 + 32, 60);
    expect(r.store.getState().view.az).toBeCloseTo(90, 3);
    expect(r.store.getState().ar.heading.source).toBe('absolute');
    r.push({ alpha: 0, beta: 90, gamma: 0, absolute: false, atMs: T0 + 20 + ABSOLUTE_HOLD_MS });
    drive(controller, T0 + 32 + 60 * 16, 120);
    expect(r.store.getState().ar.heading.source).toBe('relative');
    controller.dispose();
  });

  it('corrects an iOS pose with the compass and grades the accuracy, invalid reading as relative', async () => {
    const r = rig();
    enter(r);
    const controller = r.create();
    await settle();
    // Flat, top toward device alpha 0 but the compass says the top points at 90 (magnetic east).
    r.push({ alpha: 0, beta: 0, gamma: 0, compassHeading: 90, compassAccuracy: 10, atMs: T0 + 20 });
    controller.update(TT, T0 + 32);
    expect(r.store.getState().ar.heading).toEqual({
      source: 'compass',
      accuracyDeg: 10,
      level: 'good',
    });
    // Looking at the nadir: the azimuth is the screen top's, which the compass put at 90.
    expect(r.store.getState().view.alt).toBeCloseTo(-89.99, 2);
    expect(r.store.getState().view.az).toBeCloseTo(90, 3);
    r.push({ alpha: 0, beta: 0, gamma: 0, compassHeading: 90, compassAccuracy: 20, atMs: T0 + 40 });
    controller.update(TT, T0 + 48);
    expect(r.store.getState().ar.heading.level).toBe('fair');
    r.push({ alpha: 0, beta: 0, gamma: 0, compassHeading: 90, compassAccuracy: 40, atMs: T0 + 56 });
    controller.update(TT, T0 + 64);
    expect(r.store.getState().ar.heading.level).toBe('poor');
    r.push({ alpha: 0, beta: 0, gamma: 0, compassHeading: 90, compassAccuracy: -1, atMs: T0 + 72 });
    controller.update(TT, T0 + 80);
    expect(r.store.getState().ar.heading).toEqual({
      source: 'relative',
      accuracyDeg: -1,
      level: 'invalid',
    });
    controller.dispose();
  });

  it('fails with orientationUnavailable when no sample arrives, or the last one is stale', async () => {
    const r = rig();
    enter(r);
    const controller = r.create();
    await settle();
    controller.update(TT, T0);
    controller.update(TT, T0 + STALE_SAMPLE_MS);
    expect(r.store.getState().ar.mode).toBe('sensor');
    controller.update(TT, T0 + STALE_SAMPLE_MS + 1);
    expect(r.store.getState().ar).toMatchObject({ mode: 'off', error: 'orientationUnavailable' });
    controller.dispose();

    const t = rig();
    enter(t);
    const second = t.create();
    await settle();
    second.update(TT, T0);
    t.push({ alpha: 270, beta: 90, gamma: 0, absolute: true, atMs: T0 + 2000 });
    second.update(TT, T0 + 2016);
    second.update(TT, T0 + 2000 + STALE_SAMPLE_MS);
    expect(t.store.getState().ar.mode).toBe('sensor');
    second.update(TT, T0 + 2000 + STALE_SAMPLE_MS + 1);
    expect(t.store.getState().ar).toMatchObject({ mode: 'off', error: 'orientationUnavailable' });
    second.dispose();
  });

  it('pauses the pose publication during an XR session and resumes with a fresh grace', async () => {
    const r = rig();
    enter(r);
    const controller = r.create();
    await settle();
    r.push({ alpha: 270, beta: 90, gamma: 0, absolute: true, atMs: T0 + 20 });
    controller.update(TT, T0 + 32);
    r.setArPose.mockClear();
    r.store.getState().actions.setArMode('xr');
    r.push({ alpha: 0, beta: 90, gamma: 0, absolute: true, atMs: T0 + 40 });
    drive(controller, T0 + 32, 400);
    expect(r.setArPose).not.toHaveBeenCalled();
    expect(r.store.getState().ar.mode).toBe('xr');
    // Back to the sensor mode long after the last sample: the grace restarts, no staleness.
    r.store.getState().actions.setArMode('sensor');
    const back = T0 + 32 + 400 * 16;
    controller.update(TT, back + 16);
    expect(r.store.getState().ar.mode).toBe('sensor');
    expect(r.setArPose).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it('a track that ends inside an XR session is restarted on the return to the sensor mode', async () => {
    const r = rig();
    enter(r);
    const controller = r.create();
    await settle();
    r.camera.emitSize(1280, 720);
    r.store.getState().actions.setArMode('xr');
    r.store.getState().actions.setArXr({ phase: 'active' });
    // ARCore takes the camera: the handle ends the track; AR and the session stay (R94).
    r.camera.end('trackEnded');
    expect(r.store.getState().ar).toMatchObject({ mode: 'xr', error: null });
    expect(r.camera.stop).toHaveBeenCalledTimes(1);
    expect(controller.video()).toBeNull();
    controller.update(TT, T0 + 16);
    expect(r.startCameraVideo).toHaveBeenCalledTimes(1);
    // The session ends: the flow writes `sensor` then `idle`; the next tick reacquires the camera.
    const second = fakeCamera();
    r.startCameraVideo.mockImplementation(() => Promise.resolve(second.cam));
    r.store.getState().actions.setArMode('sensor');
    r.store.getState().actions.setArXr({ phase: 'idle', aligned: null });
    controller.update(TT, T0 + 32);
    controller.update(TT, T0 + 48);
    expect(r.startCameraVideo).toHaveBeenCalledTimes(2);
    await settle();
    expect(controller.video()).toBe(second.cam.video);
    expect(r.store.getState().ar).toMatchObject({ mode: 'sensor', error: null });
    second.emitSize(640, 480);
    expect(r.store.getState().ar.frame).toEqual({ width: 640, height: 480 });
    // The new handle's end is handled like the first one's.
    second.end('trackEnded');
    expect(r.store.getState().ar).toMatchObject({ mode: 'off', error: 'trackEnded' });
    controller.dispose();
  });

  it.each(['trackEnded', 'hidden'] as const)(
    'an end (%s) while the XR entry is pending waits for its outcome before restarting the camera',
    async (reason) => {
      const r = rig();
      enter(r);
      const controller = r.create();
      await settle();
      r.push({ alpha: 270, beta: 90, gamma: 0, absolute: true, atMs: T0 + 20 });
      r.store.getState().actions.setArXr({ phase: 'entering' });
      // The Play Services install flow hides the page (R85), or the track ends early (R94).
      r.camera.end(reason);
      expect(r.store.getState().ar).toMatchObject({ mode: 'sensor', error: null });
      expect(controller.video()).toBeNull();
      controller.update(TT, T0 + 32);
      expect(r.startCameraVideo).toHaveBeenCalledTimes(1);
      // The entry fails (an `xr*` code keeps the sensor mode): the camera comes back.
      const second = fakeCamera();
      r.startCameraVideo.mockImplementation(() => Promise.resolve(second.cam));
      r.store.getState().actions.failAr('xrUnsupported');
      expect(r.store.getState().ar).toMatchObject({ mode: 'sensor', xr: { phase: 'idle' } });
      controller.update(TT, T0 + 48);
      expect(r.startCameraVideo).toHaveBeenCalledTimes(2);
      await settle();
      expect(controller.video()).toBe(second.cam.video);
      expect(r.store.getState().ar.mode).toBe('sensor');
      controller.dispose();
      expect(second.stop).toHaveBeenCalledTimes(1);
    },
  );

  it('a camera that cannot be reacquired after the session leaves AR with its code', async () => {
    const r = rig();
    enter(r);
    const controller = r.create();
    await settle();
    r.store.getState().actions.setArMode('xr');
    r.camera.end('trackEnded');
    r.startCameraVideo.mockImplementation(() =>
      Promise.reject(new CameraVideoFailure('cameraDenied')),
    );
    r.store.getState().actions.setArMode('sensor');
    controller.update(TT, T0 + 16);
    await settle();
    expect(r.store.getState().ar).toMatchObject({ mode: 'off', error: 'cameraDenied' });
    controller.dispose();

    const t = rig();
    enter(t);
    const second = t.create();
    await settle();
    t.store.getState().actions.setArMode('xr');
    t.camera.end('trackEnded');
    t.startCameraVideo.mockImplementation(() => Promise.reject(new Error('boom')));
    t.store.getState().actions.setArMode('sensor');
    second.update(TT, T0 + 16);
    await settle();
    expect(t.store.getState().ar).toMatchObject({ mode: 'off', error: 'trackEnded' });
    second.dispose();
  });

  it('dispose stops the sensors and the camera, ignores late events and is idempotent', async () => {
    const r = rig();
    enter(r);
    const controller = r.create();
    await settle();
    controller.dispose();
    controller.dispose();
    expect(r.sensorsStop).toHaveBeenCalledTimes(1);
    expect(r.camera.stop).toHaveBeenCalledTimes(1);
    expect(controller.video()).toBeNull();
    const before = r.store.getState();
    r.camera.emitSize(640, 480);
    r.camera.end('trackEnded');
    r.push({ alpha: 1, beta: 2, gamma: 3, absolute: true, atMs: T0 + 50 });
    controller.update(TT, T0 + 64);
    expect(r.store.getState()).toBe(before);
  });

  it('stops a camera that resolves after dispose and ignores a rejection after dispose', async () => {
    const r = rig();
    enter(r);
    let resolveCamera: (cam: CameraVideo) => void = () => undefined;
    const controller = r.create({
      startCameraVideo: () =>
        new Promise<CameraVideo>((resolve) => {
          resolveCamera = resolve;
        }),
    });
    await settle();
    controller.dispose();
    resolveCamera(r.camera.cam);
    await settle();
    expect(r.camera.stop).toHaveBeenCalledTimes(1);
    expect(controller.video()).toBeNull();

    const t = rig();
    enter(t);
    let rejectCamera: (error: unknown) => void = () => undefined;
    const second = t.create({
      startCameraVideo: () =>
        new Promise<CameraVideo>((_resolve, reject) => {
          rejectCamera = reject;
        }),
    });
    await settle();
    second.dispose();
    rejectCamera(new CameraVideoFailure('cameraDenied'));
    await settle();
    expect(t.store.getState().ar.error).toBeNull();
  });
});

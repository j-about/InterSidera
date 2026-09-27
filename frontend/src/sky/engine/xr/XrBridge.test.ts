// @vitest-environment node
// The WebXR bridge on Babylon's `NullEngine` (plan D161, Q65; backlog B-93): the one sanctioned
// Babylon-under-Vitest exception (rules/frontend-tests.md). A real `Scene`, `TargetCamera`,
// `WebXRSessionManager` and `WebXRCamera` (one rig camera, as Babylon builds it) stand behind a
// fake experience handed through `XrBridge.create`'s test-only seam; `trackingState`, a getter
// backed by a private setter, is overridden on the camera instance with `Object.defineProperty`.
// Asserted: the swallowed creation failure, the entry protocol (dom-overlay required, `local`
// reference space, the resolution at `IN_XR`), the rig position zeroed on every frame, the pose
// published within 1e-6 degree of the rig rotation, `delta0` captured from a compass heading at
// entry, the AR-3 offset nudges applied as yaw, `aligned = false` for a relative source, a
// `NOT_TRACKING` frame that composes nothing (no accumulated yaw), the field of view mirrored
// once from the projection (`2 atan2(1, m[5])`, the zero matrix refused) and the session end.

import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Observable } from '@babylonjs/core/Misc/observable';
import { WebXRCamera } from '@babylonjs/core/XR/webXRCamera';
import { WebXRSessionManager } from '@babylonjs/core/XR/webXRSessionManager';
import type { Mock } from 'vitest';

import { createSkyStore } from '../../../state/store';
import type { SkyStore } from '../../../state/storeTypes';
import type { HeadingSource } from '../../../state/types';
import { XrUnavailableError } from '../../ar/webxr';
import { cameraRotationFor } from '../../math/frames';
import { at, vec3 } from '../../math/typed';
import { Matrix, Quaternion, Scene, TargetCamera, Vector3 } from '../babylon';
import { WebXRDomOverlay, WebXRState, WebXRTrackingState } from './babylonXr';
import { XrBridge } from './XrBridge';
import type { XrExperienceLike, XrExperienceOptions, XrHelperLike } from './XrBridge';

const T0 = 1_757_000_000_000;
const DEG = Math.PI / 180;

/** `enableFeature` as the mock records it (Babylon's own signature is generic over the feature). */
type EnableFeatureCall = (...args: unknown[]) => unknown;

interface FakeExperience {
  experience: XrExperienceLike;
  helper: XrHelperLike & { state: WebXRState };
  camera: WebXRCamera;
  rig: TargetCamera;
  states: Observable<WebXRState>;
  ended: Observable<unknown>;
  enableFeature: Mock<EnableFeatureCall>;
  enterXRAsync: Mock<XrHelperLike['enterXRAsync']>;
  exitXRAsync: Mock<() => Promise<void>>;
  dispose: Mock<() => void>;
  /** Babylon's `_setTrackingState`, which the bridge only reads. */
  setTracking(state: WebXRTrackingState): void;
}

interface Rig {
  store: SkyStore;
  scene: Scene;
  skyCamera: TargetCamera;
  fake: FakeExperience;
  /** A function-typed property (not a method signature): `expect(r.hooks.onSessionEnded)` is fine. */
  hooks: { onSessionEnded: Mock<() => void> };
  overlay: HTMLElement;
  options: XrExperienceOptions | null;
}

/** The DOM-overlay root as `attachOffsetDrag` uses it, without a DOM (the node environment). */
function fakeOverlay(): HTMLElement {
  const element = {
    style: { touchAction: '' },
    clientHeight: 800,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setPointerCapture: () => undefined,
    releasePointerCapture: () => undefined,
  };
  return element as unknown as HTMLElement;
}

function fakeExperience(scene: Scene): FakeExperience {
  const sessionManager = new WebXRSessionManager(scene);
  const camera = new WebXRCamera('xr', scene, sessionManager);
  const rig = camera.rigCameras[0];
  if (!(rig instanceof TargetCamera)) {
    throw new Error('Babylon built no rig camera');
  }
  let tracking = WebXRTrackingState.NOT_TRACKING;
  Object.defineProperty(camera, 'trackingState', {
    configurable: true,
    get: () => tracking,
  });
  const states = new Observable<WebXRState>();
  const ended = new Observable<unknown>();
  const enableFeature = vi.fn<EnableFeatureCall>(() => ({}));
  const helper: XrHelperLike & { state: WebXRState } = {
    camera,
    onStateChangedObservable: states,
    state: WebXRState.NOT_IN_XR,
    sessionManager: { onXRSessionEnded: ended },
    // The generic Babylon signature cannot be satisfied by a plain mock: the mock is recorded
    // under its own call type and handed over as the real one.
    featuresManager: {
      enableFeature: enableFeature as unknown as XrHelperLike['featuresManager']['enableFeature'],
    },
    // Babylon sets `IN_XR` synchronously inside the first XR frame, before its promise settles.
    enterXRAsync: vi.fn<XrHelperLike['enterXRAsync']>(() => {
      helper.state = WebXRState.ENTERING_XR;
      states.notifyObservers(WebXRState.ENTERING_XR);
      helper.state = WebXRState.IN_XR;
      states.notifyObservers(WebXRState.IN_XR);
      return Promise.resolve(sessionManager);
    }),
    exitXRAsync: vi.fn<() => Promise<void>>(() => {
      helper.state = WebXRState.NOT_IN_XR;
      ended.notifyObservers(undefined);
      return Promise.resolve();
    }),
  };
  const dispose = vi.fn<() => void>();
  const experience: XrExperienceLike = {
    baseExperience: helper,
    renderTarget: {} as XrExperienceLike['renderTarget'],
    dispose,
  };
  return {
    experience,
    helper,
    camera,
    rig,
    states,
    ended,
    enableFeature,
    enterXRAsync: helper.enterXRAsync as Mock<XrHelperLike['enterXRAsync']>,
    exitXRAsync: helper.exitXRAsync as Mock<() => Promise<void>>,
    dispose,
    setTracking(state) {
      tracking = state;
    },
  };
}

/** A store in the sensor mode at `view.az`, with the heading `source` (the AR-4 reference). */
function sensorStore(az: number, source: HeadingSource): SkyStore {
  const store = createSkyStore({ az, alt: 10, fov: 60 }, T0);
  const { actions } = store.getState();
  actions.requestAr();
  actions.setArMode('sensor');
  actions.setArXr({ support: 'supported' });
  actions.setArHeading({ source, accuracyDeg: source === 'compass' ? 5 : null, level: 'good' });
  return store;
}

async function rig(
  options: { az?: number; source?: HeadingSource } = {},
): Promise<Rig & { bridge: XrBridge }> {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const skyCamera = new TargetCamera('sky', Vector3.Zero(), scene);
  skyCamera.minZ = 1;
  skyCamera.maxZ = 2000;
  const fake = fakeExperience(scene);
  const store = sensorStore(options.az ?? 200, options.source ?? 'compass');
  const hooks: { onSessionEnded: Mock<() => void> } = { onSessionEnded: vi.fn<() => void>() };
  const captured: { options: XrExperienceOptions | null } = { options: null };
  const bridge = await XrBridge.create(scene, skyCamera, store, hooks, (s, o) => {
    expect(s).toBe(scene);
    captured.options = o;
    return Promise.resolve(fake.experience);
  });
  return {
    store,
    scene,
    skyCamera,
    fake,
    hooks,
    overlay: fakeOverlay(),
    options: captured.options,
    bridge,
  };
}

/** Babylon re-poses the rig from the viewer pose every tracked frame: the world rotation of a camera looking at (az, alt, roll). */
function poseRig(rig: TargetCamera, az: number, alt: number, roll = 0): void {
  const euler = cameraRotationFor(vec3(), az, alt, roll);
  rig.rotationQuaternion = Quaternion.RotationYawPitchRoll(
    at(euler, 1),
    at(euler, 0),
    at(euler, 2),
  );
}

/** A symmetric perspective matrix in the WebXR/Babylon layout: `m[5] = 1 / tan(fov / 2)`, `m[0] = m[5] / aspect`. */
function projection(fovDeg: number, aspect: number): Matrix {
  const m5 = 1 / Math.tan((fovDeg / 2) * DEG);
  return Matrix.FromValues(m5 / aspect, 0, 0, 0, 0, m5, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
}

function quaternionOf(rig: TargetCamera): [number, number, number, number] {
  const q = rig.rotationQuaternion;
  if (q === null) {
    throw new Error('the rig has no rotation quaternion');
  }
  return [q.x, q.y, q.z, q.w];
}

describe('XrBridge.create (plan D128, Q65 seam)', () => {
  it('throws XrUnavailableError and disposes when Babylon swallowed the creation failure', async () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const dispose = vi.fn<() => void>();
    const store = sensorStore(0, 'none');
    await expect(
      XrBridge.create(
        scene,
        new TargetCamera('sky', Vector3.Zero(), scene),
        store,
        { onSessionEnded: () => undefined },
        () => Promise.resolve({ renderTarget: {} as XrExperienceLike['renderTarget'], dispose }),
      ),
    ).rejects.toBeInstanceOf(XrUnavailableError);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('asks for the default UI, the controller features and the online repository off, and copies the depth range', async () => {
    const r = await rig();
    expect(r.options).toMatchObject({
      disableDefaultUI: true,
      disablePointerSelection: true,
      disableTeleportation: true,
      disableNearInteraction: true,
      disableHandTracking: true,
      ignoreNativeCameraTransformation: true,
      inputOptions: { doNotLoadControllerMeshes: true, disableOnlineControllerRepository: true },
    });
    expect(r.fake.camera.minZ).toBe(1);
    expect(r.fake.camera.maxZ).toBe(2000);
    r.bridge.dispose();
  });
});

describe('XrBridge.enter', () => {
  it('requires the dom-overlay on the overlay root, enters immersive-ar in the local space and resolves at IN_XR', async () => {
    const r = await rig();
    await r.bridge.enter(r.overlay);
    expect(r.fake.enableFeature).toHaveBeenCalledWith(
      WebXRDomOverlay,
      'latest',
      { element: r.overlay, supressXRSelectEvents: true },
      true,
      true,
    );
    expect(r.fake.enterXRAsync).toHaveBeenCalledWith(
      'immersive-ar',
      'local',
      r.fake.experience.renderTarget,
      {},
    );
    // The drag surface is armed on the overlay (touch gestures off).
    expect(r.overlay.style.touchAction).toBe('none');
    await expect(r.bridge.enter(r.overlay)).rejects.toMatchObject({ name: 'InvalidStateError' });
    r.bridge.dispose();
  });

  it('turns a refused dom-overlay feature into the entry rejection', async () => {
    const r = await rig();
    r.fake.enableFeature.mockImplementationOnce(() => {
      throw new Error('feature not registered');
    });
    await expect(r.bridge.enter(r.overlay)).rejects.toThrow('feature not registered');
    expect(r.fake.enterXRAsync).not.toHaveBeenCalled();
    r.bridge.dispose();
  });
});

describe('XrBridge.tick (plan D130)', () => {
  it('zeroes the rig position on every frame and composes nothing before the first pose', async () => {
    const r = await rig();
    await r.bridge.enter(r.overlay);
    const before = r.store.getState().view;
    r.fake.rig.position.set(1, 2, 3);
    const q0 = quaternionOf(r.fake.rig);
    r.bridge.tick();
    expect([r.fake.rig.position.x, r.fake.rig.position.y, r.fake.rig.position.z]).toEqual([
      0, 0, 0,
    ]);
    expect(quaternionOf(r.fake.rig)).toEqual(q0);
    expect(r.store.getState().view).toBe(before);
    expect(r.store.getState().ar.xr.aligned).toBeNull();
    r.bridge.dispose();
  });

  it('publishes the pose within 1e-6 degree, aligns north from the compass heading at entry and mirrors the field once', async () => {
    const r = await rig({ az: 200, source: 'compass' });
    await r.bridge.enter(r.overlay);
    // The first tracked frame: the rig looks at az 120, alt 30 in XR space while the sensor pose
    // at entry said 200: `delta0 = 200 - 120 = 80` and the published azimuth is the entry one.
    r.fake.setTracking(WebXRTrackingState.TRACKING);
    poseRig(r.fake.rig, 120, 30);
    r.fake.rig.position.set(0.5, 1.6, -0.2);
    r.bridge.tick();
    let view = r.store.getState().view;
    expect(Math.abs(view.az - 200)).toBeLessThan(1e-6);
    expect(Math.abs(view.alt - 30)).toBeLessThan(1e-6);
    expect(Math.abs(r.store.getState().ar.roll)).toBeLessThan(1e-6);
    expect(r.store.getState().ar.xr.aligned).toBe(true);
    expect([r.fake.rig.position.x, r.fake.rig.position.y, r.fake.rig.position.z]).toEqual([
      0, 0, 0,
    ]);
    // The rig's own quaternion carries the correction in place (the scene renders it).
    const corrected = quaternionOf(r.fake.rig);
    poseRig(r.fake.rig, 200, 30);
    const expected = quaternionOf(r.fake.rig);
    for (let i = 0; i < 4; i += 1) {
      expect(Math.abs(Math.abs(at(corrected, i)) - Math.abs(at(expected, i)))).toBeLessThan(1e-9);
    }
    // The zero projection of a never-posed rig reads 180 degrees and is refused: the field stays.
    expect(view.fov).toBe(60);
    // A posed projection is mirrored: `2 atan2(1, m[5])`, once per session (Babylon stores the
    // matrix in Float32, hence the 1e-5 degree tolerance; rules/sky-math.md).
    r.fake.rig.freezeProjectionMatrix(projection(70, 0.5));
    poseRig(r.fake.rig, 120, 30);
    r.bridge.tick();
    view = r.store.getState().view;
    expect(Math.abs(view.fov - 70)).toBeLessThan(1e-5);
    r.fake.rig.freezeProjectionMatrix(projection(50, 0.5));
    poseRig(r.fake.rig, 120, 30);
    r.bridge.tick();
    expect(Math.abs(r.store.getState().view.fov - 70)).toBeLessThan(1e-5);

    // The AR-3 drag nudges the offset: applied as a yaw on top of `delta0`.
    r.store.getState().actions.nudgeArOffset(10);
    poseRig(r.fake.rig, 120, 30);
    r.bridge.tick();
    expect(Math.abs(r.store.getState().view.az - 210)).toBeLessThan(1e-6);
    r.store.getState().actions.nudgeArOffset(-25);
    poseRig(r.fake.rig, 120, 30);
    r.bridge.tick();
    expect(Math.abs(r.store.getState().view.az - 185)).toBeLessThan(1e-6);

    // A frame Babylon did not pose (tracking lost): the rig still holds the previous corrected
    // quaternion, so nothing is composed again and the view keeps its azimuth.
    const held = quaternionOf(r.fake.rig);
    const viewBefore = r.store.getState().view;
    r.fake.setTracking(WebXRTrackingState.NOT_TRACKING);
    r.fake.rig.position.set(3, 3, 3);
    r.bridge.tick();
    expect(quaternionOf(r.fake.rig)).toEqual(held);
    expect(r.store.getState().view).toBe(viewBefore);
    expect([r.fake.rig.position.x, r.fake.rig.position.y, r.fake.rig.position.z]).toEqual([
      0, 0, 0,
    ]);
    // Tracking resumes with a fresh pose: the same correction applies (no accumulation).
    r.fake.setTracking(WebXRTrackingState.TRACKING);
    poseRig(r.fake.rig, 120, 30);
    r.bridge.tick();
    expect(Math.abs(r.store.getState().view.az - 185)).toBeLessThan(1e-6);
    // Roll rides along: a rig rolled 15 degrees publishes it (plan D119 sign).
    poseRig(r.fake.rig, 120, 30, 15);
    r.bridge.tick();
    expect(Math.abs(r.store.getState().ar.roll - 15)).toBeLessThan(1e-6);
    r.bridge.dispose();
  });

  it('leaves aligned false with a relative heading source and applies no yaw', async () => {
    const r = await rig({ az: 200, source: 'relative' });
    await r.bridge.enter(r.overlay);
    r.fake.setTracking(WebXRTrackingState.TRACKING);
    poseRig(r.fake.rig, 120, 30);
    r.bridge.tick();
    expect(r.store.getState().ar.xr.aligned).toBe(false);
    expect(Math.abs(r.store.getState().view.az - 120)).toBeLessThan(1e-6);
    expect(Math.abs(r.store.getState().view.alt - 30)).toBeLessThan(1e-6);
    // `TRACKING_LOST` still counts as a posed frame (Babylon emulates the pose).
    r.fake.setTracking(WebXRTrackingState.TRACKING_LOST);
    poseRig(r.fake.rig, 130, 30);
    r.bridge.tick();
    expect(Math.abs(r.store.getState().view.az - 130)).toBeLessThan(1e-6);
    r.bridge.dispose();
  });
});

describe('XrBridge session end and disposal', () => {
  it('reports the session end once, ignores ticks afterwards and exits idempotently', async () => {
    const r = await rig();
    await r.bridge.enter(r.overlay);
    await r.bridge.exit();
    expect(r.fake.exitXRAsync).toHaveBeenCalledTimes(1);
    expect(r.hooks.onSessionEnded).toHaveBeenCalledTimes(1);
    // The drag was detached with the session; a tick outside a session does nothing.
    r.fake.setTracking(WebXRTrackingState.TRACKING);
    poseRig(r.fake.rig, 90, 0);
    const before = r.store.getState().view;
    r.bridge.tick();
    expect(r.store.getState().view).toBe(before);
    // An exit with no session is a no-op that resolves.
    await r.bridge.exit();
    expect(r.fake.exitXRAsync).toHaveBeenCalledTimes(1);
    // A second session re-reads the entry reference.
    r.store.getState().actions.setView({ az: 40 });
    await r.bridge.enter(r.overlay);
    poseRig(r.fake.rig, 120, 0);
    r.bridge.tick();
    expect(Math.abs(r.store.getState().view.az - 40)).toBeLessThan(1e-6);
    r.bridge.dispose();
    r.bridge.dispose();
    expect(r.fake.dispose).toHaveBeenCalledTimes(1);
    expect(r.fake.ended.hasObservers()).toBe(false);
    await expect(r.bridge.enter(r.overlay)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('ends silently when the session ends before its first frame', async () => {
    const r = await rig();
    r.fake.enterXRAsync.mockImplementationOnce(() => {
      r.fake.helper.state = WebXRState.ENTERING_XR;
      r.fake.states.notifyObservers(WebXRState.ENTERING_XR);
      r.fake.helper.state = WebXRState.NOT_IN_XR;
      r.fake.states.notifyObservers(WebXRState.NOT_IN_XR);
      return Promise.resolve(new WebXRSessionManager(r.scene));
    });
    await expect(r.bridge.enter(r.overlay)).rejects.toMatchObject({ name: 'AbortError' });
    expect(r.hooks.onSessionEnded).not.toHaveBeenCalled();
    r.bridge.dispose();
  });
});

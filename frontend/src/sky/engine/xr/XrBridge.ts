// The WebXR bridge (AR-4 [S]; brief l.240-241, l.543; plan D128, D129, D130): the Babylon side
// of an `immersive-ar` session, in the lazy `XrBridge` chunk with `babylonXr.ts` (the XR
// side-effect set) and `xrFlow.ts` (the store transitions, re-exported below so `SkyEngine`
// imports this one module). Entry: `WebXRDefaultExperience.CreateAsync` with the default UI,
// pointer selection, teleportation, near interaction and hand tracking off and
// `ignoreNativeCameraTransformation` (Babylon's own first-frame compensation is latched one
// observer too late on the first session); the `dom-overlay` feature is REQUIRED on the overlay
// root (the exit control must stay visible; without it the session is refused with
// `NotSupportedError`, backlog B-81); `enterXRAsync('immersive-ar', 'local', renderTarget, {})`
// (`local` never falls back to `viewer`; Babylon's `unbounded` advice is a `console.warn` per
// entry); `enter()` resolves at the first rendered frame (`WebXRState.IN_XR`), not when the
// session was created. Camera at the origin (brief l.543, plan D130): every XR frame Babylon
// writes the rig cameras' `position`/`rotationQuaternion` from the viewer pose BEFORE the
// engine's render loop runs `SkyEngine.tick`, so `tick()` zeroes every rig position (the parent
// `WebXRCamera` is untouched, so Babylon's reference-space rebasing stays a no-op and
// `worldScalingFactor` stays 1) and composes `q_total = yaw(delta) (x) q_rig` in place, where
// `delta = delta0 + (ar.azOffsetDeg - offsetAtEntry)`; `delta0` is fixed at the first frame with
// `trackingState === TRACKING`: `entryAz - az_xr` when the heading source was absolute or a
// compass, where `entryAz` and the source are `view.az` and `ar.heading.source` captured at
// `IN_XR`, BEFORE this bridge writes `view.az` itself (the controller's last sensor pose, heading
// plus the AR-3 offset: the heading "sampled just before the session" of brief l.240; ARCore may
// take frames or seconds after the session opened before it tracks; `xr.aligned = true`), else 0
// (`aligned = false`, the overlay asks for a manual alignment). A frame Babylon did not pose
// (`trackingState === NOT_TRACKING`: no viewer pose yet, or a mid-session loss) only zeroes the
// positions: the rig still holds the previous corrected quaternion, so composing again would
// accumulate the yaw, and its frozen projection is the zero matrix before the first pose. The
// pose reaches the store through `setArPose(az, alt, roll)` from `basisFromBabylonQuaternion` +
// `viewFromAxes` (the same rule as the sensors), and `view.fov` mirrors the rig's projection once
// per session from a posed rig (`fovAspectFromProjection`). Every frame's math is pure and
// allocation-free; the ENU <-> Babylon relabelling stays in `frames.ts`. The AR-3 drag runs on
// the overlay root (`sky/ar/offsetDrag.ts`) for the session's duration.

import type { SkyActions, SkyStore } from '../../../state/storeTypes';
import type { HeadingSource } from '../../../state/types';
import { attachOffsetDrag } from '../../ar/offsetDrag';
import { XrUnavailableError } from '../../ar/webxr';
import { RAD, basisFromBabylonQuaternion } from '../../math/frames';
import {
  applyYaw,
  fovAspectFromProjection,
  viewFromAxes,
  yawCorrectionDeg,
} from '../../math/orientation';
import type { FovAspect, ViewPose } from '../../math/orientation';
import { quat, vec3 } from '../../math/typed';
import type { Quat, Vec3 } from '../../math/typed';
import { TargetCamera } from '../babylon';
import type { Scene } from '../babylon';
import {
  WebXRDefaultExperience,
  WebXRDomOverlay,
  WebXRState,
  WebXRTrackingState,
} from './babylonXr';
import type { WebXRExperienceHelper } from './babylonXr';
import type { XrBridgeHooks, XrBridgeLike } from './xrFlow';

export { XrFlow } from './xrFlow';
export type { XrBridgeHooks, XrBridgeLike, XrFlowDeps } from './xrFlow';

/** `local`: the origin near the viewer, tracking tuned for staying in place (plan D128, B-81). */
const REFERENCE_SPACE: XRReferenceSpaceType = 'local';

function endedBeforeFirstFrame(): DOMException {
  return new DOMException('the WebXR session ended before its first frame', 'AbortError');
}

/** Babylon throws a plain string without an XR system; it survives for `classifyXrFailure`. */
function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export class XrBridge implements XrBridgeLike {
  private readonly xr: WebXRDefaultExperience;
  private readonly helper: WebXRExperienceHelper;
  private readonly store: SkyStore;
  private readonly hooks: XrBridgeHooks;
  private readonly removeObservers: (() => void)[] = [];
  /** The entry in flight; `exit()` during the entry awaits it, then ends the session. */
  private entry: Promise<void> | null = null;
  /** Between the first rendered frame (`IN_XR`) and the session end. */
  private inSession = false;
  private detachDrag: (() => void) | null = null;
  private disposed = false;
  // Per-session alignment state (plan D130).
  private aligned = false;
  private delta0 = 0;
  private offsetAtEntry = 0;
  /** `view.az` and `ar.heading.source` at `IN_XR`: the AR-4 reference (brief l.240), read once. */
  private entryAz = 0;
  private entrySource: HeadingSource = 'none';
  private fovMirrored = false;
  // Scratch storage (nothing is allocated per frame).
  private readonly qRig: Quat = quat();
  private readonly forward: Vec3 = vec3();
  private readonly right: Vec3 = vec3();
  private readonly up: Vec3 = vec3();
  private readonly pose: ViewPose = { az: 0, alt: 0, roll: 0 };
  private readonly fovAspect: FovAspect = { fovRad: 0, aspect: 1 };

  private constructor(
    xr: WebXRDefaultExperience,
    helper: WebXRExperienceHelper,
    store: SkyStore,
    hooks: XrBridgeHooks,
  ) {
    this.xr = xr;
    this.helper = helper;
    this.store = store;
    this.hooks = hooks;
    const ended = helper.sessionManager.onXRSessionEnded;
    const observer = ended.add(() => {
      this.onSessionEnded();
    });
    this.removeObservers.push(() => {
      ended.remove(observer);
    });
  }

  /**
   * Create the default experience on `scene` once per engine (plan D128); the XR camera takes
   * the sky camera's depth range (`minZ` 1, `maxZ` 2000: the sphere sits at 1000). Babylon
   * swallows its own creation error and returns a result without `baseExperience`: that is the
   * `XrUnavailableError` (-> `xrUnsupported`) rather than a later `TypeError`.
   */
  static async create(
    scene: Scene,
    skyCamera: TargetCamera,
    store: SkyStore,
    hooks: XrBridgeHooks,
  ): Promise<XrBridge> {
    const xr = await WebXRDefaultExperience.CreateAsync(scene, {
      disableDefaultUI: true,
      disablePointerSelection: true,
      disableTeleportation: true,
      disableNearInteraction: true,
      disableHandTracking: true,
      ignoreNativeCameraTransformation: true,
      // `WebXRInput` otherwise fetches the controller profiles list from
      // immersive-web.github.io at construction: a foreign origin (brief l.580), caught by
      // `collectForeignRequests` in ar.spec.ts. Meshes and the repository stay off.
      inputOptions: { doNotLoadControllerMeshes: true, disableOnlineControllerRepository: true },
    });
    // Typed non-optional by Babylon, undefined after a swallowed failure (never `!`).
    const helper = (xr as { baseExperience?: WebXRExperienceHelper }).baseExperience;
    if (helper === undefined) {
      xr.dispose();
      throw new XrUnavailableError();
    }
    helper.camera.minZ = skyCamera.minZ;
    helper.camera.maxZ = skyCamera.maxZ;
    return new XrBridge(xr, helper, store, hooks);
  }

  /**
   * Start a session with `overlay` as the `dom-overlay` root (re-enabled per session: the AR
   * chrome is a new element each AR session). Resolves at the first rendered frame; rejects
   * with the browser's `DOMException`, Babylon's string, or an `AbortError` when the session
   * ended before its first frame (the back gesture during the ARCore start, kept silent).
   */
  enter(overlay: HTMLElement): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new DOMException('the WebXR bridge is disposed', 'AbortError'));
    }
    if (this.entry !== null || this.inSession) {
      return Promise.reject(
        new DOMException('a WebXR session is already open', 'InvalidStateError'),
      );
    }
    const entry = this.startSession(overlay).finally(() => {
      this.entry = null;
    });
    this.entry = entry;
    return entry;
  }

  private startSession(overlay: HTMLElement): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const { helper } = this;
      const states = helper.onStateChangedObservable;
      let done = false;
      let entered = false;
      let endedEarly = false;
      let sessionEnded = false;
      const settle = (error: Error | null): void => {
        if (done) {
          return;
        }
        done = true;
        states.remove(observer);
        if (error === null) {
          this.beginSession(overlay);
          resolve();
        } else {
          reject(error);
        }
      };
      // Registered before `enterXRAsync`: Babylon sets `IN_XR` synchronously inside the first XR
      // frame and `NOT_IN_XR` when the session ends or the entry fails (before the rejection
      // reaches us, so a failure keeps its own error and an early end waits for the promise).
      const observer = states.add((state) => {
        if (state === WebXRState.IN_XR) {
          settle(null);
        } else if (state === WebXRState.EXITING_XR) {
          // A session end (the back gesture during the ARCore start) passes through `EXITING_XR`;
          // Babylon's own failure path goes `ENTERING_XR` -> `NOT_IN_XR` without it.
          sessionEnded = true;
        } else if (state === WebXRState.NOT_IN_XR) {
          endedEarly = true;
          if (entered) {
            settle(endedBeforeFirstFrame());
          }
        }
      });
      // Required: a browser without `dom-overlay` refuses the session (`NotSupportedError`) and
      // the user gets the AR-5 message instead of a session with no exit control (B-81). A
      // synchronous throw (a conflicting or unregistered feature) settles through `settle` so the
      // state observer never outlives this entry.
      try {
        helper.featuresManager.enableFeature(
          WebXRDomOverlay,
          'latest',
          { element: overlay, supressXRSelectEvents: true },
          true,
          true,
        );
      } catch (error: unknown) {
        settle(toError(error));
        return;
      }
      helper.enterXRAsync('immersive-ar', REFERENCE_SPACE, this.xr.renderTarget, {}).then(
        () => {
          entered = true;
          if (helper.state === WebXRState.IN_XR) {
            settle(null);
          } else if (endedEarly) {
            settle(endedBeforeFirstFrame());
          }
        },
        (error: unknown) => {
          // A session the user ended while Babylon still awaited the reference space or the
          // layer makes those calls throw on the ended session (`InvalidStateError`): the same
          // silent early end as a session ended before its first frame, not `xrBusy`.
          settle(sessionEnded ? endedBeforeFirstFrame() : toError(error));
        },
      );
    });
  }

  /**
   * The first frame rendered (`IN_XR`): the session is live, the drag surface armed, the
   * alignment reset. The AR-4 reference is read HERE, before `tick()` writes `view.az` itself:
   * `view.az` still holds the sensor controller's last pose (the heading plus the AR-3 offset,
   * the heading "sampled just before the session" of brief l.240), and the first tracked frame
   * that consumes it may come frames or seconds later.
   */
  private beginSession(overlay: HTMLElement): void {
    const { view, ar } = this.store.getState();
    this.inSession = true;
    this.aligned = false;
    this.delta0 = 0;
    this.entryAz = view.az;
    this.entrySource = ar.heading.source;
    this.offsetAtEntry = ar.azOffsetDeg;
    this.fovMirrored = false;
    this.detachDrag?.();
    this.detachDrag = attachOffsetDrag(overlay, this.store);
  }

  /**
   * End the session: an entry in flight is awaited first (Babylon's `exitXRAsync` is a no-op
   * before the session exists, so an exit pressed during the entry must wait for it); a failed
   * entry leaves nothing to end. Resolves once Babylon restored the scene.
   */
  async exit(): Promise<void> {
    const entry = this.entry;
    if (entry !== null) {
      try {
        await entry;
      } catch {
        return;
      }
    }
    if (!this.inSession || this.disposed) {
      return;
    }
    await this.helper.exitXRAsync();
  }

  /** Babylon's `onXRSessionEnded` (any cause): the scene is restored, the flow is told once. */
  private onSessionEnded(): void {
    const wasInSession = this.inSession;
    this.inSession = false;
    this.detachDrag?.();
    this.detachDrag = null;
    if (wasInSession && !this.disposed) {
      this.hooks.onSessionEnded();
    }
  }

  /**
   * Once per XR frame from `SkyEngine.tick`, after Babylon's camera observer and before
   * `scene.render` (plan D130): rig positions zeroed, the yaw correction composed in place, the
   * pose published, the field mirrored once. No allocation. Babylon's observer re-posed the rigs
   * this frame iff a viewer pose existed (`trackingState` is written in the same call,
   * `NOT_TRACKING` on a null pose): on an un-posed frame the rig still holds the previous
   * corrected quaternion and the zero projection of a rig never posed, so only the positions
   * are zeroed.
   */
  tick(): void {
    if (!this.inSession || this.disposed) {
      return;
    }
    const xrCamera = this.helper.camera;
    const rigs = xrCamera.rigCameras;
    const state = this.store.getState();
    const posed = xrCamera.trackingState !== WebXRTrackingState.NOT_TRACKING;
    let first = true;
    for (const rig of rigs) {
      if (!(rig instanceof TargetCamera) || rig.rotationQuaternion === null) {
        continue;
      }
      rig.position.setAll(0);
      if (!posed) {
        continue;
      }
      const q = rig.rotationQuaternion;
      this.qRig[0] = q.x;
      this.qRig[1] = q.y;
      this.qRig[2] = q.z;
      this.qRig[3] = q.w;
      if (first && !this.aligned && xrCamera.trackingState === WebXRTrackingState.TRACKING) {
        this.alignNorth(state.actions);
      }
      const delta = this.delta0 + (state.ar.azOffsetDeg - this.offsetAtEntry);
      applyYaw(this.qRig, delta, this.qRig);
      q.copyFromFloats(this.qRig[0], this.qRig[1], this.qRig[2], this.qRig[3]);
      if (first) {
        first = false;
        basisFromBabylonQuaternion(this.forward, this.right, this.up, this.qRig);
        viewFromAxes(this.pose, this.forward, this.up);
        state.actions.setArPose(this.pose.az, this.pose.alt, this.pose.roll);
        if (!this.fovMirrored) {
          this.mirrorFov(rig, state.view.fov, state.actions);
        }
      }
    }
  }

  /**
   * The first tracked frame (plan D130): `delta0 = entryAz - az_xr` when the heading source at
   * `IN_XR` was absolute or a compass (`entryAz` = the sensor heading plus the AR-3 offset,
   * captured by `beginSession` before this bridge wrote `view.az`), else 0 and the manual hint.
   * `qRig` holds the uncorrected rig rotation at this point.
   */
  private alignNorth(actions: SkyActions): void {
    this.aligned = true;
    const headed = this.entrySource === 'absolute' || this.entrySource === 'compass';
    if (headed) {
      basisFromBabylonQuaternion(this.forward, this.right, this.up, this.qRig);
      viewFromAxes(this.pose, this.forward, this.up);
      this.delta0 = yawCorrectionDeg(this.entryAz, this.pose.az);
    } else {
      this.delta0 = 0;
    }
    actions.setArXr({ aligned: headed });
  }

  /**
   * `view.fov` = the rig's vertical field, once per session (the XR bridge owns it, plan D123).
   * Called for a posed rig only (`tick`); the zero matrix of a rig never posed would read 180
   * degrees, which the bound below refuses as well.
   */
  private mirrorFov(rig: TargetCamera, currentFov: number, actions: SkyActions): void {
    fovAspectFromProjection(this.fovAspect, rig.getProjectionMatrix().m);
    const fovDeg = this.fovAspect.fovRad * RAD;
    if (!(fovDeg > 0 && fovDeg < 180)) {
      return;
    }
    this.fovMirrored = true;
    if (fovDeg !== currentFov) {
      actions.setView({ fov: fovDeg });
    }
  }

  /** Idempotent: observers removed, the drag detached, the experience disposed (a session ends). */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.inSession = false;
    this.detachDrag?.();
    this.detachDrag = null;
    for (const remove of this.removeObservers) {
      remove();
    }
    this.removeObservers.length = 0;
    this.xr.dispose();
  }
}

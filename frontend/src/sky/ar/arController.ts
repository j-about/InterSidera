// The sensor-mode AR controller (AR-1..AR-3, brief l.237-239, l.546-547; plan D116, D118, D121,
// D123, D125). The lazy `arController` chunk: Babylon-free, DOM and store allowed, reached only
// through `await import('../ar/arController')` in `SkyEngine` when `ar.mode` becomes
// `requesting`, ticked by the engine after the other tickers and disposed when the mode returns
// to `off`. Flow: wait while `ar.permission` reads `idle` or `pending` (the button asks
// `requestPermission()` synchronously, writes `pending`, then the outcome after the dialog;
// `denied` -> `orientationDenied`; `granted`, `prompt`, `notRequired` continue), start the camera
// video in the engine's underlay (its end listener is registered first: an end the handle replays,
// the page hidden during the prompt or `play()`, leaves AR at once and the engine disposes this
// controller before the sensors start), start the orientation sensors, publish `sensor`, probe
// WebXR. A `requesting` that no permission write follows waits for the overlay's cancel button.
// A stream that ends while an XR session runs or is being entered (ARCore owns the camera in an
// `immersive-ar` session; the Play Services install flow hides the page meanwhile, plan R85, R94)
// does not leave AR: the camera is restarted on the first tick that finds the sensor mode with an
// idle XR phase, and only a failed restart fails AR (the camera's code, `trackEnded` otherwise).
// Per engine tick: consume the latest sample (one reusable slot; the source is arbitrated per
// sample and an absolute sample suppresses the relative stream for one second), correct an iOS
// pose with the compass, fold the screen angle, smooth on the quaternion with the engine clock
// (`tau` 80 ms), derive `(az, alt, roll)`, add the AR-3 offset and call `setArPose` once. Nothing
// is written when no sample arrived, the smoothing converged and the offset did not move.
// Staleness on the engine clock: no usable sample within `STALE_SAMPLE_MS` of the start (or of
// the last one) ends the session with `orientationUnavailable` (the sensorless desktop's null
// events never count). No timer, no allocation per update (scratch quaternions and poses are
// fields).

import type { Backend, CompassLevel, HeadingSource, XrSupport } from '../../state/types';
import type { ArController, ArHost } from '../engine/types';
import {
  COMPASS_AXIS_TOP,
  SMOOTHING_TAU_S,
  STALE_SAMPLE_MS,
  compassCorrectedQuaternion,
  compassLevel,
  deviceQuaternion,
  pageQuaternion,
  smoothPose,
  viewFromPose,
} from '../math/orientation';
import type { ViewPose } from '../math/orientation';
import { copyQ, dotQ } from '../math/quaternion';
import { quat } from '../math/typed';
import { CameraVideoFailure, startCameraVideo } from './cameraVideo';
import type { CameraVideo, CameraVideoDeps } from './cameraVideo';
import { startOrientationSensors } from './sensors';
import type { OrientationSample, OrientationSensorHandle } from './sensors';
import { probeXr, xrSystemOf } from './webxr';

/** An absolute sample silences the relative stream for this long (Android fires both). */
export const ABSOLUTE_HOLD_MS = 1000;
/** `|dot| >= 1 - eps` between the smoothed and the target rotation counts as converged (~0.005 deg). */
const CONVERGED_DOT = 1 - 1e-9;

/** Every collaborator is injectable (tests); the defaults are the real modules and globals. */
export interface ArControllerDeps {
  startCameraVideo?: typeof startCameraVideo;
  startOrientationSensors?: typeof startOrientationSensors;
  /** `sky/ar/webxr.ts::probeXr` on `navigator.xr` (plan D129); the default narrows the value. */
  probeXr?: (xr: unknown, backend: Backend | null) => Promise<XrSupport>;
  /** `navigator.mediaDevices` (an explicit `undefined` means an insecure context). */
  mediaDevices?: Pick<MediaDevices, 'getUserMedia'> | undefined;
  window?: CameraVideoDeps['window'];
  document?: CameraVideoDeps['document'];
  /** The clock the sensor samples are stamped with; must be the engine's (`Date.now`). */
  now?: () => number;
}

/** `navigator.xr` is untyped here (`unknown`): the structural guard keeps `sky/ar` free of the XR globals. */
function defaultProbeXr(xr: unknown, backend: Backend | null): Promise<XrSupport> {
  return probeXr(xrSystemOf(xr), backend);
}

function defaultMediaDevices(): Pick<MediaDevices, 'getUserMedia'> | undefined {
  // Widened by annotation: lib.dom types `mediaDevices` as always present.
  const nav: { mediaDevices?: MediaDevices } = navigator;
  return nav.mediaDevices;
}

function copySample(out: OrientationSample, s: Readonly<OrientationSample>): void {
  out.alpha = s.alpha;
  out.beta = s.beta;
  out.gamma = s.gamma;
  out.absolute = s.absolute;
  out.compassHeading = s.compassHeading;
  out.compassAccuracy = s.compassAccuracy;
  out.screenAngle = s.screenAngle;
  out.atMs = s.atMs;
}

class SensorArController implements ArController {
  private readonly host: ArHost;
  private readonly deps: ArControllerDeps;
  private readonly now: () => number;
  private readonly abort = new AbortController();
  private unsubscribePermission: (() => void) | null = null;
  private camera: CameraVideo | null = null;
  /** The stream ended inside an XR session or its entry (R94): restarted on the return to `sensor`. */
  private cameraLost = false;
  private sensors: OrientationSensorHandle | null = null;
  private disposed = false;
  private started = false;

  // The latest accepted sample (copied out of the sensors' reusable object) and its bookkeeping.
  private readonly latest: OrientationSample = {
    alpha: NaN,
    beta: NaN,
    gamma: NaN,
    absolute: false,
    compassHeading: NaN,
    compassAccuracy: NaN,
    screenAngle: 0,
    atMs: NaN,
  };
  private fresh = false;
  private latestAtMs = -Infinity;
  private lastAbsoluteAtMs = -Infinity;
  /** The staleness grace starts here: the first update, and the return from an XR session. */
  private graceFromMs = NaN;
  private lastUpdateMs = NaN;
  private inXr = false;

  // Pose state: scratch quaternions and the two poses (target and published), never reallocated.
  private readonly qDevice = quat();
  private readonly qCorrected = quat();
  private readonly qTarget = quat();
  private readonly qCurrent = quat();
  private readonly pose: ViewPose = { az: 0, alt: 0, roll: 0 };
  private readonly targetPose: ViewPose = { az: 0, alt: 0, roll: 0 };
  private hasPose = false;
  private converged = false;
  private lastOffsetDeg = NaN;

  // Heading publication (on change only) and the D118 offset rules.
  private publishedSource: HeadingSource = 'none';
  private publishedAccuracy: number | null = null;
  private publishedLevel: CompassLevel = 'none';
  private offsetUpgradeDone = false;

  constructor(host: ArHost, deps: ArControllerDeps) {
    this.host = host;
    this.deps = deps;
    this.now = deps.now ?? ((): number => Date.now());
    this.start();
  }

  /** Wait for the permission outcome the button wrote (plan D126), then begin. */
  private start(): void {
    const { store } = this.host;
    this.unsubscribePermission = store.subscribe(
      (s) => s.ar.permission,
      (permission) => {
        if (this.disposed || this.started) {
          return;
        }
        if (permission === 'idle' || permission === 'pending') {
          return;
        }
        this.started = true;
        this.unsubscribePermission?.();
        this.unsubscribePermission = null;
        if (permission === 'denied') {
          store.getState().actions.failAr('orientationDenied');
          return;
        }
        void this.begin();
      },
      { fireImmediately: true },
    );
  }

  private cameraDeps(): CameraVideoDeps {
    const camDeps: CameraVideoDeps = {
      mediaDevices: 'mediaDevices' in this.deps ? this.deps.mediaDevices : defaultMediaDevices(),
    };
    if (this.deps.document !== undefined) {
      camDeps.document = this.deps.document;
    }
    if (this.deps.window !== undefined) {
      camDeps.window = this.deps.window;
    }
    return camDeps;
  }

  private startCamera(): Promise<CameraVideo> {
    const start = this.deps.startCameraVideo ?? startCameraVideo;
    return start(this.host.underlayRoot, this.cameraDeps(), this.abort.signal);
  }

  /**
   * Adopt a camera handle: the end listener first, then the frame listener. An end that preceded
   * the handle (the page hidden during the camera prompt or while `play()` was pending, a track
   * lost meanwhile) is replayed at once; `exitAr`/`failAr` reach the engine's `applyArMode('off')`,
   * which disposes this controller synchronously. The one guard then covers both that replay and
   * a controller disposed while the camera prompt was up: the stream is released and the caller
   * starts nothing else (`disposed` is read once, after the call that may flip it). Returns
   * whether the handle was kept.
   */
  private adoptCamera(camera: CameraVideo): boolean {
    const { store } = this.host;
    const { actions } = store.getState();
    camera.onEnded((reason) => {
      if (this.disposed) {
        return;
      }
      const { ar } = store.getState();
      if (ar.mode === 'xr' || ar.xr.phase === 'entering') {
        // ARCore owns the camera inside an `immersive-ar` session, and the Google Play Services
        // for AR install flow hides the page while the entry is pending (R85, R94): the stream
        // was stopped by the handle; `update` restarts it once the sensor mode is idle again.
        this.camera = null;
        this.cameraLost = true;
        return;
      }
      if (reason === 'hidden') {
        actions.exitAr();
      } else {
        actions.failAr('trackEnded');
      }
    });
    if (this.disposed) {
      camera.stop();
      return false;
    }
    this.camera = camera;
    camera.onFrameSize((width, height) => {
      if (!this.disposed) {
        actions.setArFrame({ width, height });
      }
    });
    return true;
  }

  /** The camera lost to an XR session (R94) is reacquired; a failure now leaves AR. */
  private async restartCamera(): Promise<void> {
    let camera: CameraVideo;
    try {
      camera = await this.startCamera();
    } catch (error: unknown) {
      if (!this.disposed) {
        this.host.store
          .getState()
          .actions.failAr(error instanceof CameraVideoFailure ? error.code : 'trackEnded');
      }
      return;
    }
    this.adoptCamera(camera);
  }

  private async begin(): Promise<void> {
    const { store } = this.host;
    const { actions } = store.getState();
    let camera: CameraVideo;
    try {
      camera = await this.startCamera();
    } catch (error: unknown) {
      if (!this.disposed) {
        actions.failAr(error instanceof CameraVideoFailure ? error.code : 'cameraUnavailable');
      }
      return;
    }
    if (!this.adoptCamera(camera)) {
      return;
    }
    const startSensors = this.deps.startOrientationSensors ?? startOrientationSensors;
    this.sensors = startSensors({
      onSample: (sample) => {
        this.onSample(sample);
      },
      now: this.now,
    });
    actions.setArMode('sensor');

    const probe = this.deps.probeXr ?? defaultProbeXr;
    const nav: { xr?: unknown } = navigator;
    void probe(nav.xr, store.getState().engine.kind)
      .then((support) => {
        if (this.disposed) {
          return;
        }
        store.getState().actions.setArXr({ support });
        if (support === 'supported') {
          void this.host.preloadXr().catch(() => undefined);
        }
      })
      .catch(() => undefined);
  }

  /** Per-sample arbitration (plan D116): a relative sample within the hold of an absolute one is dropped. */
  private onSample(sample: Readonly<OrientationSample>): void {
    if (this.disposed) {
      return;
    }
    if (sample.absolute) {
      this.lastAbsoluteAtMs = sample.atMs;
    } else if (sample.atMs - this.lastAbsoluteAtMs < ABSOLUTE_HOLD_MS) {
      return;
    }
    copySample(this.latest, sample);
    this.latestAtMs = sample.atMs;
    this.fresh = true;
  }

  update(_tt: number, nowMs: number): void {
    if (this.disposed || this.sensors === null) {
      return;
    }
    const state = this.host.store.getState();
    const { actions, ar } = state;
    if (ar.mode === 'xr') {
      // The bridge writes the pose during a session; the sensors keep listening for the return.
      this.inXr = true;
      this.lastUpdateMs = nowMs;
      return;
    }
    if (this.cameraLost && ar.xr.phase === 'idle') {
      // Back in the sensor mode after a session, or after an entry that failed (R94).
      this.cameraLost = false;
      void this.restartCamera();
    }
    if (Number.isNaN(this.graceFromMs) || this.inXr) {
      this.inXr = false;
      this.graceFromMs = nowMs;
      this.converged = false;
    }
    if (nowMs - Math.max(this.latestAtMs, this.graceFromMs) > STALE_SAMPLE_MS) {
      actions.failAr('orientationUnavailable');
      return;
    }
    const dtS = Number.isNaN(this.lastUpdateMs) ? 0 : (nowMs - this.lastUpdateMs) / 1000;
    this.lastUpdateMs = nowMs;

    if (this.fresh) {
      this.fresh = false;
      this.consumeSample(state.ar.azOffsetDeg, state.ar.viewBefore?.az ?? state.view.az);
    }
    if (!this.hasPose) {
      return;
    }
    const offsetDeg = this.host.store.getState().ar.azOffsetDeg;
    if (this.converged && offsetDeg === this.lastOffsetDeg) {
      return;
    }
    if (!this.converged) {
      smoothPose(this.qCurrent, this.qCurrent, this.qTarget, dtS, SMOOTHING_TAU_S);
      if (Math.abs(dotQ(this.qCurrent, this.qTarget)) >= CONVERGED_DOT) {
        copyQ(this.qCurrent, this.qTarget);
        this.converged = true;
      }
    }
    viewFromPose(this.pose, this.qCurrent);
    this.lastOffsetDeg = offsetDeg;
    actions.setArPose(this.pose.az + offsetDeg, this.pose.alt, this.pose.roll);
  }

  /** The fresh sample -> source, heading level, target rotation and the D118 offset rules. */
  private consumeSample(offsetDeg: number, azBeforeDeg: number): void {
    const s = this.latest;
    const { actions } = this.host.store.getState();
    const hasCompass = Number.isFinite(s.compassHeading);
    const accuracyDeg = hasCompass && Number.isFinite(s.compassAccuracy) ? s.compassAccuracy : null;
    let source: HeadingSource;
    if (s.absolute) {
      source = 'absolute';
    } else if (hasCompass && accuracyDeg !== null && accuracyDeg >= 0) {
      source = 'compass';
    } else {
      source = 'relative';
    }
    // An iOS compass without a valid figure is used as a relative source and shown as `invalid`.
    const level = compassLevel(
      source === 'relative' && hasCompass ? 'compass' : source,
      accuracyDeg,
    );
    if (
      source !== this.publishedSource ||
      accuracyDeg !== this.publishedAccuracy ||
      level !== this.publishedLevel
    ) {
      this.publishedSource = source;
      this.publishedAccuracy = accuracyDeg;
      this.publishedLevel = level;
      actions.setArHeading({ source, accuracyDeg, level });
    }

    deviceQuaternion(this.qDevice, s.alpha, s.beta, s.gamma);
    if (source === 'compass') {
      compassCorrectedQuaternion(this.qCorrected, this.qDevice, s.compassHeading, COMPASS_AXIS_TOP);
    } else {
      copyQ(this.qCorrected, this.qDevice);
    }
    pageQuaternion(this.qTarget, this.qCorrected, s.screenAngle);
    this.converged = false;

    const headed = source === 'absolute' || source === 'compass';
    if (!this.hasPose) {
      // Entry (plan D118): a headed source starts from offset 0; a relative one keeps the
      // direction the user was looking at (`offset = az_before - az_sensor`, no jump).
      this.hasPose = true;
      copyQ(this.qCurrent, this.qTarget);
      if (headed) {
        this.offsetUpgradeDone = true;
        if (offsetDeg !== 0) {
          actions.setArOffset(0);
        }
      } else {
        viewFromPose(this.targetPose, this.qTarget);
        actions.setArOffset(azBeforeDeg - this.targetPose.az);
      }
    } else if (headed && !this.offsetUpgradeDone) {
      // The first upgrade from the relative source resets the offset once; later changes keep it.
      this.offsetUpgradeDone = true;
      if (offsetDeg !== 0) {
        actions.setArOffset(0);
      }
    }
  }

  video(): HTMLVideoElement | null {
    return this.camera?.video ?? null;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.abort.abort();
    this.unsubscribePermission?.();
    this.unsubscribePermission = null;
    this.sensors?.stop();
    this.sensors = null;
    this.camera?.stop();
    this.camera = null;
  }
}

/** Create and start the controller (plan D116); the engine calls `update` per tick and `dispose`. */
export function createArController(host: ArHost, deps: ArControllerDeps = {}): ArController {
  return new SensorArController(host, deps);
}

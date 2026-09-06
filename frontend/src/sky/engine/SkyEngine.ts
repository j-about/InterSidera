// The sky engine (plan D80-D86; brief l.85-89, l.408, l.537-545). Framework-agnostic: React
// reaches it only through `createSkyEngine` and `dispose`; everything else arrives through
// store subscriptions (view, layers, options, observer, meta) and the frame source. The engine
// owns time: every render tick derives `tt` from the store's control block, drives the frame
// buffer, evaluates the current window and publishes the `tt` mirror at most twice per second.
// Geometry lives in ENU under the frozen world matrix P of `frames.ts` (ADR-0009); Babylon's
// only jobs are the camera, the meshes and the render loop. Nothing here allocates per frame.

import { shallow } from 'zustand/vanilla/shallow';

import { ttAt } from '../../state/clock';
import type { MetaResponse, SkyStore } from '../../state/storeTypes';
import { createFrameEval } from '../../state/types';
import type {
  AdapterInfo,
  Backend,
  FrameEval,
  LayerFlags,
  Observer,
  Options,
  ViewState,
} from '../../state/types';
import { DEG, cameraRotationFor, enuToBabylonMatrix } from '../math/frames';
import { refractionFactor } from '../math/refraction';
import { magnitudeLimitForFov } from '../math/stars';
import { clampTt, yearsSinceEpoch } from '../math/time';
import { at, vec3 } from '../math/typed';
import type { Vec3 } from '../math/typed';
import { CameraController } from './CameraController';
import { Color4, Matrix, Scene, TargetCamera, Vector3 } from './babylon';
import type { AbstractEngine } from './babylon';
import { abortError, createEngine } from './createEngine';
import type { CreatedEngine } from './createEngine';
import { BodiesLayer } from './layers/BodiesLayer';
import { LineLayers } from './layers/LineLayers';
import { StarLayer } from './layers/StarLayer';
import type { StarUniforms } from './layers/StarLayer';
import type {
  FrameSource,
  SkyEngineApi,
  SkyEngineFactory,
  SkyEngineOptions,
  StarCatalogInput,
} from './types';

/** The `tt` mirror reaches the store at most this often (plan D80, brief l.552). */
const PUBLISH_INTERVAL_MS = 500;
/** Rotating overlays refresh at <= 10 Hz (brief l.68). */
const LINES_INTERVAL_MS = 100;
/** `fps()` and `frameMs()` average over the last ten seconds (plan D86). */
const FPS_WINDOW_MS = 10_000;
/** Ring capacity: ten seconds at up to 200 Hz. */
const FPS_RING = 2048;
/** Body capacity before `/meta` arrives (SKY-2 lists eleven bodies). */
const DEFAULT_BODY_CAPACITY = 16;
/** Camera depth range: the sphere sits at 1000 (brief l.59, l.543 "maxZ must exceed"). */
const CAMERA_MIN_Z = 1;
const CAMERA_MAX_Z = 2000;
/** Retina-class screens render at 2x at most (plan D85). */
const MAX_DEVICE_PIXEL_RATIO = 2;
/** Consecutive failing frames (about one second) before the engine gives up. */
const MAX_FRAME_FAILURES = 60;

class SkyEngine implements SkyEngineApi {
  readonly backend: Backend;
  readonly adapterInfo: AdapterInfo | null;
  current: FrameEval;

  private readonly engine: AbstractEngine;
  private readonly scene: Scene;
  private readonly camera: TargetCamera;
  private readonly store: SkyStore;
  private readonly frames: FrameSource;
  private readonly signal: AbortSignal;
  private readonly stars: StarLayer;
  private readonly bodies: BodiesLayer;
  private readonly lines: LineLayers;
  private readonly controller: CameraController;
  private readonly resizeObserver: ResizeObserver | null;
  private readonly unsubscribe: (() => void)[] = [];
  private readonly rotation: Vec3 = vec3();
  private readonly starUniforms: StarUniforms;
  private catalog: StarCatalogInput | null = null;
  private view: ViewState;
  private observer: Observer;
  private meta: MetaResponse | null = null;
  private refractionWanted: boolean;
  private refractionOn = false;
  private refractionFactorValue = 1;
  private maglimOverride: number | null;
  private coverage: [number, number] | null = null;
  /** A frame window has been evaluated at least once: before that the horizon rotation is unknown. */
  private hasFrame = false;
  private tt = NaN;
  private lastPublishMs = -Infinity;
  private lastLinesMs = -Infinity;
  private disposed = false;
  private readonly frameStamps = new Float64Array(FPS_RING);
  private readonly frameCosts = new Float64Array(FPS_RING);
  private frameHead = 0;
  private frameCount = 0;
  private frameFailures = 0;
  private readonly readyPromise: Promise<void>;
  private readyResolve: (() => void) | null = null;
  private readyArmed = false;

  constructor(created: CreatedEngine, options: SkyEngineOptions) {
    this.engine = created.engine;
    this.backend = created.backend;
    this.adapterInfo = created.adapterInfo;
    this.store = options.store;
    this.frames = options.frames;
    this.signal = options.signal;
    this.readyPromise = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });

    const scene = new Scene(this.engine);
    scene.autoClear = true;
    scene.clearColor = new Color4(0, 0, 0, 1);
    // Every sky mesh is always active (brief l.545): no per-frame frustum work.
    scene.skipFrustumClipping = true;
    // The Scene constructor attaches Babylon's input manager; the camera controller owns the
    // DOM events instead (plan D81, D85).
    scene.detachControl();
    this.scene = scene;

    this.camera = new TargetCamera('sky-camera', Vector3.Zero(), scene);
    this.camera.minZ = CAMERA_MIN_Z;
    this.camera.maxZ = CAMERA_MAX_Z;

    // The single ENU -> Babylon mapping, applied once as the world matrix of every mesh (D72).
    const world = Matrix.FromArray(enuToBabylonMatrix());
    this.stars = new StarLayer(scene, this.backend, world);
    this.bodies = new BodiesLayer(scene, this.backend, world);
    this.lines = new LineLayers(scene, world);

    const state = this.store.getState();
    this.view = state.view;
    this.observer = state.observer;
    this.refractionWanted = state.options.refr;
    this.maglimOverride = state.options.maglim;
    this.current = createFrameEval(DEFAULT_BODY_CAPACITY);
    this.starUniforms = {
      horizonQ: this.current.horizonQ,
      observerVelocity: this.current.observerVelocity,
      years: 0,
      refractionOn: false,
      refractionFactor: 1,
      viewportWidth: 1,
      viewportHeight: 1,
      fovRad: 1,
      magLimit: 6.5,
      pixelScale: 1,
    };

    // Store -> engine (plan D80): selector subscriptions, fired once for the initial state.
    this.unsubscribe.push(
      this.store.subscribe(
        (s) => s.view,
        (view) => {
          this.applyView(view);
        },
        { equalityFn: shallow, fireImmediately: true },
      ),
      this.store.subscribe(
        (s) => s.layers,
        (layers) => {
          this.applyLayers(layers);
        },
        { equalityFn: shallow, fireImmediately: true },
      ),
      this.store.subscribe(
        (s) => s.options,
        (opts) => {
          this.applyOptions(opts);
        },
        { equalityFn: (a, b) => a.refr === b.refr && a.maglim === b.maglim, fireImmediately: true },
      ),
      this.store.subscribe(
        (s) => s.observer,
        (observer) => {
          this.applyObserver(observer);
        },
        { equalityFn: shallow, fireImmediately: true },
      ),
      this.store.subscribe(
        (s) => s.meta,
        (meta) => {
          this.applyMeta(meta);
        },
        { fireImmediately: true },
      ),
    );

    this.controller = new CameraController(options.canvas, this.store);
    this.resizeObserver =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            this.resize();
          });
    this.resizeObserver?.observe(options.canvas);
    this.resize();

    this.signal.addEventListener('abort', this.dispose);
    this.engine.runRenderLoop(this.renderFrame);
  }

  setCatalog(catalog: StarCatalogInput): void {
    this.catalog = catalog;
    this.stars.setCatalog(catalog);
  }

  currentTt(): number {
    return this.tt;
  }

  whenReady(): Promise<void> {
    return this.readyPromise;
  }

  fps(): number {
    const n = this.recentFrames();
    if (n < 2) {
      return 0;
    }
    const newest = at(this.frameStamps, this.ringIndex(0));
    const oldest = at(this.frameStamps, this.ringIndex(n - 1));
    const span = newest - oldest;
    return span > 0 ? ((n - 1) * 1000) / span : 0;
  }

  frameMs(): number {
    const n = this.recentFrames();
    if (n === 0) {
      return 0;
    }
    let total = 0;
    for (let k = 0; k < n; k += 1) {
      total += at(this.frameCosts, this.ringIndex(k));
    }
    return total / n;
  }

  starCount(): number {
    return this.stars.count;
  }

  /** Match the canvas to its CSS size at up to 2 device pixels per CSS pixel (plan D85). */
  resize(): void {
    if (this.disposed) {
      return;
    }
    const ratio = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
    this.engine.setHardwareScalingLevel(1 / Math.min(ratio, MAX_DEVICE_PIXEL_RATIO));
    this.engine.resize();
  }

  /** Idempotent: the React cleanup and the abort signal may both call it (brief l.551). */
  readonly dispose = (): void => {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.signal.removeEventListener('abort', this.dispose);
    this.engine.stopRenderLoop();
    for (const stop of this.unsubscribe) {
      stop();
    }
    this.unsubscribe.length = 0;
    this.controller.dispose();
    this.resizeObserver?.disconnect();
    this.stars.dispose();
    this.bodies.dispose();
    this.lines.dispose();
    this.scene.dispose();
    this.engine.dispose();
  };

  /**
   * Babylon's render loop has no try/catch: a throw inside the callback ends the loop for good
   * (`_renderLoop` queues the next animation frame only after the callbacks return). One bad
   * frame is skipped and reported instead; a run of them stops the loop and marks the engine
   * failed rather than leaving a frozen sky with no signal.
   */
  private readonly renderFrame = (): void => {
    if (this.disposed) {
      return;
    }
    const start = performance.now();
    try {
      this.tick(Date.now());
      this.scene.render();
    } catch (error) {
      this.failFrame(error);
      return;
    }
    this.frameFailures = 0;
    this.recordFrame(start, performance.now() - start);
    this.armReady();
  };

  private failFrame(error: unknown): void {
    this.frameFailures += 1;
    if (this.frameFailures === 1) {
      console.error('sky engine frame failed', error);
    }
    if (this.frameFailures >= MAX_FRAME_FAILURES) {
      this.engine.stopRenderLoop(this.renderFrame);
      this.store.getState().actions.setEngine({ status: 'failed' });
    }
  }

  /** One simulation step at wall time `nowMs` (plan D75, D80). */
  private tick(nowMs: number): void {
    const state = this.store.getState();
    let tt = ttAt(state.clock, nowMs, state.clock.ttMinusUtc);
    if (this.coverage !== null) {
      const clamped = clampTt(tt, this.coverage);
      if (clamped !== tt) {
        // TIME-4: the time control stops at the coverage bound; playing pauses there.
        if (state.clock.mode === 'playing') {
          state.actions.setTime(clamped, nowMs);
        }
        tt = clamped;
      }
    }
    this.tt = tt;
    this.controller.update(nowMs);
    this.frames.update(tt, nowMs);
    this.frames.evaluate(tt, this.current);
    if (nowMs - this.lastPublishMs >= PUBLISH_INTERVAL_MS) {
      this.lastPublishMs = nowMs;
      state.actions.publishTt(tt);
    }
    if (!this.current.valid) {
      return;
    }
    if (!this.hasFrame) {
      // The stars, the equatorial grid and the ecliptic were kept hidden until now: with the
      // identity quaternion they would have been drawn in ICRF orientation (the bodies mesh
      // stays empty until this first update anyway). `updateDynamic` below runs in this same
      // tick, so the overlays appear with their first real rotation.
      this.hasFrame = true;
      this.applyLayers(state.layers);
    }
    const width = this.engine.getRenderWidth();
    const height = this.engine.getRenderHeight();
    const pixelScale = 1 / this.engine.getHardwareScalingLevel();
    const fovRad = this.view.fov * DEG;
    if (this.catalog !== null) {
      const u = this.starUniforms;
      u.horizonQ = this.current.horizonQ;
      u.observerVelocity = this.current.observerVelocity;
      u.years = yearsSinceEpoch(tt, this.catalog.columns.epochTt);
      u.refractionOn = this.refractionOn;
      u.refractionFactor = this.refractionFactorValue;
      u.viewportWidth = width;
      u.viewportHeight = height;
      u.fovRad = fovRad;
      u.magLimit =
        this.maglimOverride ?? magnitudeLimitForFov(this.view.fov, this.catalog.magnitudeLimit);
      u.pixelScale = pixelScale;
      this.stars.update(u);
    }
    this.bodies.update(
      this.current,
      this.view,
      this.refractionOn,
      this.refractionFactorValue,
      width,
      height,
      fovRad,
      pixelScale,
    );
    if (nowMs - this.lastLinesMs >= LINES_INTERVAL_MS) {
      this.lastLinesMs = nowMs;
      this.lines.updateDynamic(this.current);
    }
  }

  private applyView(view: ViewState): void {
    this.view = view;
    cameraRotationFor(this.rotation, view.az, view.alt);
    this.camera.rotation.set(this.rotation[0], this.rotation[1], this.rotation[2]);
    this.camera.fov = view.fov * DEG;
  }

  private applyLayers(layers: LayerFlags): void {
    // Everything that depends on the horizon rotation waits for the first frame window.
    this.stars.setVisible(layers.stars && this.hasFrame);
    this.bodies.setVisible(layers.planets);
    this.lines.setVisibility(layers, this.hasFrame);
  }

  private applyOptions(options: Options): void {
    this.refractionWanted = options.refr;
    this.maglimOverride = options.maglim;
    this.updateRefraction();
  }

  private applyObserver(observer: Observer): void {
    this.observer = observer;
    this.updateRefraction();
    this.updateCoverage();
  }

  private applyMeta(meta: MetaResponse | null): void {
    this.meta = meta;
    if (meta !== null) {
      const capacity = meta.bodies.length + 1;
      if (capacity > this.current.mag.length) {
        this.current = createFrameEval(capacity);
      }
      this.bodies.setCapacity(meta.bodies.length);
    }
    this.updateCoverage();
  }

  /** Refraction applies on Earth only (SKY-7), with the standard pressure at the elevation. */
  private updateRefraction(): void {
    this.refractionOn = this.refractionWanted && this.observer.body === 'earth';
    this.refractionFactorValue = refractionFactor(this.observer.elev);
  }

  /** `/meta.coverage.ephemeris_tt` intersected with the observer's `coverage_tt` (plan D75). */
  private updateCoverage(): void {
    if (this.meta === null) {
      this.coverage = null;
      return;
    }
    const ephemeris = this.meta.coverage.ephemeris_tt;
    let start = ephemeris[0];
    let end = ephemeris[1];
    const observer = this.meta.observers.find((o) => o.id === this.observer.body);
    if (observer !== undefined) {
      start = Math.max(start, observer.coverage_tt[0]);
      end = Math.min(end, observer.coverage_tt[1]);
    }
    this.coverage = [start, end];
  }

  /** Ready = catalog uploaded, a frame window rendered and every shader compiled (plan D86). */
  private armReady(): void {
    if (this.readyArmed || this.catalog === null || !this.current.valid) {
      return;
    }
    this.readyArmed = true;
    void this.scene.whenReadyAsync().then(() => {
      this.readyResolve?.();
    });
  }

  private recordFrame(stamp: number, costMs: number): void {
    this.frameStamps[this.frameHead] = stamp;
    this.frameCosts[this.frameHead] = costMs;
    this.frameHead = (this.frameHead + 1) % FPS_RING;
    if (this.frameCount < FPS_RING) {
      this.frameCount += 1;
    }
  }

  /** Ring index of the k-th most recent frame. */
  private ringIndex(k: number): number {
    return (this.frameHead - 1 - k + FPS_RING) % FPS_RING;
  }

  /** Frames recorded within the last ten seconds. */
  private recentFrames(): number {
    const now = performance.now();
    let n = 0;
    while (n < this.frameCount && now - at(this.frameStamps, this.ringIndex(n)) <= FPS_WINDOW_MS) {
      n += 1;
    }
    return n;
  }
}

/** The factory the React shell injects into `SkyCanvas` (plan D87); Babylon never runs in tests. */
export const createSkyEngine: SkyEngineFactory = async (options) => {
  const created = await createEngine(options.canvas, {
    preferBackend: options.preferBackend,
    signal: options.signal,
    xrCompatible: options.xrCompatible,
    debug: options.debug,
  });
  if (options.signal.aborted) {
    created.engine.dispose();
    throw abortError();
  }
  try {
    return new SkyEngine(created, options);
  } catch (error) {
    // A failed scene setup must not leak the GPU context it was built on.
    created.engine.dispose();
    throw error;
  }
};

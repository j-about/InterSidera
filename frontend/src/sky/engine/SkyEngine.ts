// The sky engine (plan D80-D86, D93-D94, D101-D108; brief l.85-89, l.408, l.537-545).
// Framework-agnostic: React reaches it only through `createSkyEngine`, `dispose` and the event
// handlers of `SkyEngineApi` (`pick`, `snapshot`); everything it acts on over time arrives through
// store subscriptions (view, layers, options, observer, meta, DSO types, selection, follow, centre
// requests, the catalog bundle, the constellation of the selection, the minor-body names) and the
// frame source. The engine owns time: every render tick derives `tt` from the store's control
// block, drives the frame buffer, evaluates the current window and publishes the `tt` mirror and
// the selection readout at most twice per second; the overlays (lines, constellations, labels,
// marker, follow, centring) refresh at <= 10 Hz; the visible-label list reaches the store at <= 1
// Hz on change. Geometry lives in ENU under the frozen world matrix P of `frames.ts` (ADR-0009);
// Babylon's only jobs are the camera, the meshes and the render loop. Nothing here allocates per
// frame (the 2 Hz readout copy and the label texts on an id change are the exceptions).

import { shallow } from 'zustand/vanilla/shallow';

import type { CatalogBundle } from '../../api/catalogs';
import { ttAt } from '../../state/clock';
import { observerCoverage } from '../../state/coverage';
import type { MetaResponse, MinorBodySummary, SkyActions, SkyStore } from '../../state/storeTypes';
import { createFrameEval, createSelectionReadout } from '../../state/types';
import type {
  AdapterInfo,
  Backend,
  CentreRequest,
  DsoType,
  FrameEval,
  LayerFlags,
  MinorStatus,
  Observer,
  Options,
  SelectionReadout,
  ViewState,
} from '../../state/types';
import { apparentCatalogEnu, apparentStarEnuAt, enuFromApparentIcrf } from '../math/apparent';
import { effectiveMagLimit, groundAlpha, skyBrightness } from '../math/atmosphere';
import { dsoMagnitudeLimit, dsoSizeLimitArcmin } from '../math/dso';
import {
  DEG,
  altAzToEnu,
  altitudeDeg,
  cameraBasis,
  cameraRotationFor,
  directionToScreen,
  enuToAltAz,
  enuToBabylonMatrix,
  screenToDirection,
} from '../math/frames';
import type { AltAz, ScreenPoint } from '../math/frames';
import {
  PICK_TOLERANCE_PX,
  coneCosine,
  createPickBest,
  inCone,
  nearestWithin,
  pickToleranceDeg,
  resetPickBest,
  starInCone,
  starRowLimit,
} from '../math/picking';
import { rotate, rotateInverse } from '../math/quaternion';
import { refractionFactor } from '../math/refraction';
import { magnitudeLimitForFov } from '../math/stars';
import { clampTt, yearsSinceEpoch } from '../math/time';
import { at, load3, vec3 } from '../math/typed';
import type { Vec3 } from '../math/typed';
import { CameraController } from './CameraController';
import { Color4, Matrix, Scene, TargetCamera, Vector3 } from './babylon';
import type { AbstractEngine } from './babylon';
import { abortError, createEngine } from './createEngine';
import type { CreatedEngine } from './createEngine';
import { BackgroundLayer } from './layers/BackgroundLayer';
import type { BackgroundUniforms } from './layers/BackgroundLayer';
import { BodiesLayer } from './layers/BodiesLayer';
import { ConstellationLayer } from './layers/ConstellationLayer';
import { DsoLayer } from './layers/DsoLayer';
import type { DsoUniforms } from './layers/DsoLayer';
import { LabelLayer } from './layers/LabelLayer';
import type { LabelRebuildInputs, LabelTickInputs } from './layers/LabelLayer';
import { LineLayers } from './layers/LineLayers';
import { MinorLayer } from './layers/MinorLayer';
import { StarLayer } from './layers/StarLayer';
import type { StarUniforms } from './layers/StarLayer';
import { SkyResolver } from './resolver';
import type {
  EngineTicker,
  FrameSource,
  LabelBox,
  LabelTextKey,
  LayerStats,
  SkyEngineApi,
  SkyEngineFactory,
  SkyEngineOptions,
  StarCatalogInput,
} from './types';

/** The `tt` mirror and the readout reach the store at most this often (plan D80, brief l.552). */
const PUBLISH_INTERVAL_MS = 500;
/** Rotating overlays, labels, marker, follow and centring refresh at <= 10 Hz (brief l.68). */
const OVERLAY_INTERVAL_MS = 100;
/** A centre request that cannot be resolved (object not in the window yet) is dropped after this. */
const CENTRE_TIMEOUT_MS = 10_000;
/** `snapshot()` gives up when no frame ends within this. */
const SNAPSHOT_TIMEOUT_MS = 2000;
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
const NO_TICKERS: readonly EngineTicker[] = [];

interface PendingCentre extends CentreRequest {
  sinceMs: number;
}

class SkyEngine implements SkyEngineApi {
  readonly backend: Backend;
  readonly adapterInfo: AdapterInfo | null;
  current: FrameEval;
  /** The label host and text resolver of plan D93, consumed by the labels layer. */
  readonly labelRoot: HTMLElement;
  readonly labelText: (key: LabelTextKey) => string;

  private readonly engine: AbstractEngine;
  private readonly canvas: HTMLCanvasElement;
  private readonly scene: Scene;
  private readonly camera: TargetCamera;
  private readonly store: SkyStore;
  private readonly frames: FrameSource;
  private readonly tickers: readonly EngineTicker[];
  private readonly signal: AbortSignal;
  private readonly stars: StarLayer;
  private readonly bodies: BodiesLayer;
  private readonly minor: MinorLayer;
  private readonly dso: DsoLayer;
  private readonly lines: LineLayers;
  private readonly constellations: ConstellationLayer;
  private readonly background: BackgroundLayer;
  private readonly labels: LabelLayer;
  private readonly resolver: SkyResolver;
  private readonly controller: CameraController;
  private readonly resizeObserver: ResizeObserver | null;
  private readonly unsubscribe: (() => void)[] = [];
  private readonly rotation: Vec3 = vec3();
  // Scratch storage of the per-frame paths (nothing is allocated per call).
  private readonly scratchIcrf: Vec3 = vec3();
  private readonly scratchEnu: Vec3 = vec3();
  private readonly scratchAltAz: AltAz = { alt: 0, az: 0 };
  private readonly scratchScreen: ScreenPoint = { x: 0, y: 0 };
  private readonly pickEnu: Vec3 = vec3();
  private readonly pickIcrf: Vec3 = vec3();
  private readonly camForward: Vec3 = vec3();
  private readonly camRight: Vec3 = vec3();
  private readonly camUp: Vec3 = vec3();
  private readonly sunEnu: Vec3 = vec3();
  private readonly pickBest = createPickBest();
  private readonly readout: SelectionReadout = createSelectionReadout();
  private readonly starUniforms: StarUniforms;
  private readonly dsoUniforms: DsoUniforms;
  private readonly backgroundUniforms: BackgroundUniforms;
  private readonly labelTick: LabelTickInputs;
  private readonly labelRebuild: LabelRebuildInputs;
  private readonly minorNames = new Map<string, string>();
  private readonly stats: LayerStats = { dso: 0, clinesSegments: 0 };
  private catalog: StarCatalogInput | null = null;
  private bundle: CatalogBundle | null = null;
  private view: ViewState;
  private observer: Observer;
  private layers: LayerFlags;
  private options: Options;
  private meta: MetaResponse | null = null;
  private selection: string | null;
  private follow: boolean;
  private centre: PendingCentre | null = null;
  private refractionOn = false;
  private refractionFactorValue = 1;
  private coverage: [number, number] | null = null;
  /** A frame window has been evaluated at least once: before that the horizon rotation is unknown. */
  private hasFrame = false;
  private tt = NaN;
  private skyB = 0;
  private starFade = 0;
  /** The star limit in force (fov rule or manual `maglim`), before the daylight fade. */
  private starMagLimitValue = Infinity;
  /** The DSO limits in force; `dsoMagLimitValue` is before the daylight fade (`effectiveMagLimit`). */
  private dsoMagLimitValue = 7;
  private dsoSizeLimitValue = 12;
  private lastPublishMs = -Infinity;
  private lastOverlayMs = -Infinity;
  private labelsDirty = true;
  private labelsBodies: readonly string[] | null = null;
  private labelsMinor: readonly string[] | null = null;
  private readoutPublished = false;
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
    this.canvas = options.canvas;
    this.backend = created.backend;
    this.adapterInfo = created.adapterInfo;
    this.store = options.store;
    this.frames = options.frames;
    this.tickers = options.tickers ?? NO_TICKERS;
    this.labelRoot = options.labelRoot;
    this.labelText = options.labelText;
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
    this.background = new BackgroundLayer(scene, this.backend, world);
    this.stars = new StarLayer(scene, this.backend, world);
    this.dso = new DsoLayer(scene, this.backend, world);
    this.bodies = new BodiesLayer(scene, this.backend, world);
    this.minor = new MinorLayer(scene, this.bodies.material, world);
    this.lines = new LineLayers(scene, world);
    this.constellations = new ConstellationLayer(scene, world);

    const state = this.store.getState();
    this.view = state.view;
    this.observer = state.observer;
    this.layers = state.layers;
    this.options = state.options;
    this.selection = state.selection;
    this.follow = state.follow;
    this.current = createFrameEval(DEFAULT_BODY_CAPACITY, 0);
    this.resolver = new SkyResolver(this.current);
    this.labels = new LabelLayer(this.labelRoot, this.labelText, this.resolver, this.dso);
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
      atmosphere: 0,
    };
    this.dsoUniforms = {
      horizonQ: this.current.horizonQ,
      observerVelocity: this.current.observerVelocity,
      refractionOn: false,
      refractionFactor: 1,
      viewportWidth: 1,
      viewportHeight: 1,
      fovRad: 1,
      magLimit: 7,
      sizeLimitArcmin: 12,
      pixelScale: 1,
      cameraRight: this.camRight,
      atmosphere: 0,
    };
    this.backgroundUniforms = {
      camForward: this.camForward,
      camRight: this.camRight,
      camUp: this.camUp,
      tanHalfFov: 1,
      aspect: 1,
      sunEnu: this.sunEnu,
      sunAltDeg: -90,
      groundAlpha: groundAlpha(state.options.ground),
    };
    this.labelTick = {
      frame: this.current,
      view: state.view,
      width: 1,
      height: 1,
      refractionOn: false,
      refractionFactor: 1,
      cullBelowHorizon: false,
      starMagLimit: Infinity,
      dsoMagLimit: 7,
      dsoSizeLimitArcmin: 12,
    };
    this.labelRebuild = {
      catalog: null,
      bundle: null,
      frame: this.current,
      minorNames: this.minorNames,
      density: state.options.labels,
      layers: state.layers,
      selection: state.selection,
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
        { equalityFn: shallow, fireImmediately: true },
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
      this.store.subscribe(
        (s) => s.dsoTypes,
        (types) => {
          this.applyDsoTypes(types);
        },
        { fireImmediately: true },
      ),
      this.store.subscribe(
        (s) => s.selection,
        (selection) => {
          this.selection = selection;
          this.labelsDirty = true;
        },
      ),
      this.store.subscribe(
        (s) => s.follow,
        (follow) => {
          this.follow = follow;
        },
      ),
      this.store.subscribe(
        (s) => s.centreRequest,
        (request) => {
          this.centre = request === null ? null : { ...request, sinceMs: Date.now() };
        },
        { fireImmediately: true },
      ),
      this.store.subscribe(
        (s) => s.bundle,
        (bundle) => {
          this.applyBundle(bundle);
        },
        { fireImmediately: true },
      ),
      this.store.subscribe(
        (s) => s.details.con,
        (con) => {
          this.constellations.setHighlight(con);
        },
        { fireImmediately: true },
      ),
      this.store.subscribe(
        (s) => s.frames.minor,
        (minor) => {
          this.applyMinorNames(minor, this.store.getState().minorBodies.defaults);
        },
      ),
      this.store.subscribe(
        (s) => s.minorBodies.defaults,
        (defaults) => {
          this.applyMinorNames(this.store.getState().frames.minor, defaults);
        },
      ),
    );

    this.controller = new CameraController(options.canvas, this.store, (x, y) => this.pick(x, y));
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
    this.resolver.setCatalog(catalog);
    this.constellations.setData(this.bundle?.constellations?.data ?? null, catalog);
    this.constellations.setVisibility(this.layers, this.hasFrame);
    this.labelsDirty = true;
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

  directionOf(id: string, out: Vec3): boolean {
    return this.resolver.directionOf(id, out);
  }

  readoutOf(id: string, out: SelectionReadout): boolean {
    return this.resolver.readoutOf(id, out);
  }

  labelBoxes(): LabelBox[] {
    return this.labels.labelBoxes();
  }

  skyBrightness(): number {
    return this.skyB;
  }

  layerStats(): LayerStats {
    return this.stats;
  }

  reducedMotion(): boolean {
    return this.controller.reducedMotion;
  }

  /**
   * The object under a canvas position (INFO-1, plan D106): the tap direction in ICRF, a cone
   * pre-filter over the catalogs, the survivors refined on screen, the nearest within 24 css
   * pixels scaled by the field of view; ties within 3 px prefer body > minor > DSO > star; under
   * an opaque ground nothing below the horizon is picked. Runs on a tap, never per frame.
   */
  pick(xCss: number, yCss: number): string | null {
    const current = this.current;
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (!current.valid || width <= 0 || height <= 0) {
      return null;
    }
    const { view } = this;
    const q = current.horizonQ;
    const tapEnu = this.scratchEnu;
    const tapIcrf = this.scratchIcrf;
    screenToDirection(this.scratchAltAz, xCss, yCss, width, height, view.fov, view.az, view.alt);
    altAzToEnu(tapEnu, this.scratchAltAz.alt, this.scratchAltAz.az);
    rotateInverse(tapIcrf, q, tapEnu);
    const tolDeg = pickToleranceDeg(PICK_TOLERANCE_PX, view.fov, height);
    const cosCone = coneCosine(tolDeg);
    const cullBelow = this.options.ground === 'opaque';
    const best = this.pickBest;
    resetPickBest(best, PICK_TOLERANCE_PX);
    const enu = this.pickEnu;
    const icrf = this.pickIcrf;
    const refr = this.refractionOn;
    const factor = this.refractionFactorValue;
    if (this.layers.planets) {
      for (let i = 0; i < current.bodyCount; i += 1) {
        const id = current.bodyIds[i];
        if (id === undefined) {
          continue;
        }
        load3(icrf, current.dir, 3 * i);
        enuFromApparentIcrf(enu, icrf, q, refr, factor);
        nearestWithin(best, id, 'body', this.pickDistance(xCss, yCss, width, height, cullBelow));
      }
    }
    if (this.layers.minor) {
      for (let m = 0; m < current.minorCount; m += 1) {
        const id = current.minorIds[m];
        if (id === undefined || at(current.minorDrawn, m) !== 1) {
          continue;
        }
        load3(icrf, current.minorDir, 3 * m);
        enuFromApparentIcrf(enu, icrf, q, refr, factor);
        nearestWithin(best, id, 'minor', this.pickDistance(xCss, yCss, width, height, cullBelow));
      }
    }
    if (this.layers.dso) {
      const dirs = this.resolver.dsoDirections;
      const entries = this.resolver.dsoEntries;
      // The same effective limits as the DSO shader (`uDsoLimits.x - 8 uAtmosphere`, plan D94).
      const dsoLimit = this.dsoMagLimitEffective();
      for (let row = 0; row < entries.length; row += 1) {
        load3(icrf, dirs, 3 * row);
        if (
          !inCone(icrf, tapIcrf, cosCone) ||
          !this.dso.isShown(row, dsoLimit, this.dsoSizeLimitValue)
        ) {
          continue;
        }
        apparentCatalogEnu(enu, icrf, current.observerVelocity, q, refr, factor);
        const entry = entries[row];
        if (entry !== undefined) {
          nearestWithin(
            best,
            `dso:${entry.id}`,
            'dso',
            this.pickDistance(xCss, yCss, width, height, cullBelow),
          );
        }
      }
    }
    const catalog = this.catalog;
    if (this.layers.stars && catalog !== null) {
      const { columns } = catalog;
      const years = yearsSinceEpoch(current.tt, columns.epochTt);
      const limit = starRowLimit(columns.mag, columns.count, this.starMagLimitEffective());
      for (let row = 0; row < limit; row += 1) {
        if (!starInCone(columns.dir, columns.pm, row, years, tapIcrf, cosCone)) {
          continue;
        }
        apparentStarEnuAt(enu, columns, row, years, current.observerVelocity, q, refr, factor);
        nearestWithin(
          best,
          `hip:${String(at(columns.hip, row))}`,
          'star',
          this.pickDistance(xCss, yCss, width, height, cullBelow),
        );
      }
    }
    return best.id;
  }

  /**
   * Screen distance (CSS pixels) between the tap and the direction in `pickEnu`; `Infinity`
   * when the object is behind the camera or below an opaque ground.
   */
  private pickDistance(
    xCss: number,
    yCss: number,
    width: number,
    height: number,
    cullBelow: boolean,
  ): number {
    const enu = this.pickEnu;
    const altAz = this.scratchAltAz;
    const screen = this.scratchScreen;
    const { view } = this;
    enuToAltAz(altAz, enu[0], enu[1], enu[2]);
    if (
      (cullBelow && enu[2] < 0) ||
      !directionToScreen(screen, altAz.alt, altAz.az, width, height, view.fov, view.az, view.alt)
    ) {
      return Infinity;
    }
    return Math.hypot(screen.x - xCss, screen.y - yCss);
  }

  /** The star magnitude limit the star shader draws to, daylight fade included (plan Q43). */
  private starMagLimitEffective(): number {
    return effectiveMagLimit(this.starMagLimitValue, this.starFade);
  }

  /** The DSO magnitude limit the DSO shader draws to, daylight fade included. */
  private dsoMagLimitEffective(): number {
    return effectiveMagLimit(this.dsoMagLimitValue, this.starFade);
  }

  /**
   * A PNG of the next rendered frame (VIEW-6, plan D112): the rendering canvas drawn inside
   * `onEndFrameObservable` (Babylon's own screenshot path, valid with `preserveDrawingBuffer`
   * false) onto a 2D canvas of the same size, the label overlay composited with `fillText`.
   */
  snapshot(): Promise<Blob> {
    if (this.disposed || this.store.getState().engine.status === 'failed') {
      return Promise.reject(new Error('the sky engine is not running'));
    }
    return new Promise<Blob>((resolve, reject) => {
      let done = false;
      const timer = window.setTimeout(() => {
        if (!done) {
          done = true;
          reject(new Error('snapshot timed out'));
        }
      }, SNAPSHOT_TIMEOUT_MS);
      this.engine.onEndFrameObservable.addOnce(() => {
        if (done) {
          return;
        }
        done = true;
        window.clearTimeout(timer);
        try {
          const source = this.canvas;
          const target = document.createElement('canvas');
          target.width = source.width;
          target.height = source.height;
          const ctx = target.getContext('2d');
          if (ctx === null) {
            throw new Error('no 2D context for the snapshot');
          }
          ctx.drawImage(source, 0, 0);
          const cssWidth = source.clientWidth > 0 ? source.clientWidth : source.width;
          this.labels.compositeOnto(ctx, source.width / cssWidth);
          target.toBlob((blob) => {
            if (blob === null) {
              reject(new Error('the snapshot could not be encoded'));
            } else {
              resolve(blob);
            }
          }, 'image/png');
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
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
    this.labels.dispose();
    this.stars.dispose();
    this.dso.dispose();
    this.minor.dispose();
    this.bodies.dispose();
    this.lines.dispose();
    this.constellations.dispose();
    this.background.dispose();
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
        // TIME-4: the time control stops at the coverage bound; a running clock (playing, or live
        // on a body whose data ends before now) pauses there, one guard inside, with
        // `frames.coverageStop` set for the banner, so the URL never says `t=live` for a sky
        // rendered at a clamped instant.
        if (state.clock.mode !== 'paused') {
          state.actions.stopAtBound(this.coverage, nowMs);
        }
        tt = clamped;
      }
    }
    this.tt = tt;
    this.controller.update(nowMs);
    this.frames.update(tt, nowMs);
    this.frames.evaluate(tt, this.current);
    // `for-of` over a plain, short, frozen-length array: the lint config rejects the indexed form
    // (`prefer-for-of`) and V8 escape-analyses the array iterator in optimised code.
    for (const ticker of this.tickers) {
      ticker.update(tt, nowMs);
    }
    const publishNow = nowMs - this.lastPublishMs >= PUBLISH_INTERVAL_MS;
    if (publishNow) {
      this.lastPublishMs = nowMs;
      state.actions.publishTt(tt, this.current.valid ? this.current.lstHours : NaN);
    }
    if (!this.current.valid) {
      return;
    }
    if (!this.hasFrame) {
      // The stars, the equatorial grid and the ecliptic were kept hidden until now: with the
      // identity quaternion they would have been drawn in ICRF orientation (the bodies mesh
      // stays empty until this first update anyway). The overlay tick below runs in this same
      // tick, so the overlays appear with their first real rotation.
      this.hasFrame = true;
      this.applyLayers(state.layers);
    }
    const current = this.current;
    const { view, options } = this;
    const width = this.engine.getRenderWidth();
    const height = this.engine.getRenderHeight();
    const pixelScale = 1 / this.engine.getHardwareScalingLevel();
    const fovRad = view.fov * DEG;
    const maglimOverride = options.maglim;

    // The camera basis (frames.ts) and the Sun in ENU feed the background, the billboards and
    // the daylight model (SKY-7): B from the Sun altitude, on Earth with the atmosphere on.
    cameraBasis(this.camForward, this.camRight, this.camUp, view.az, view.alt);
    rotate(this.sunEnu, current.horizonQ, current.sunDir);
    const sunAltDeg = altitudeDeg(this.sunEnu[0], this.sunEnu[1], this.sunEnu[2]);
    const atmosphereOn = options.atm && this.observer.body === 'earth';
    this.skyB = atmosphereOn ? skyBrightness(sunAltDeg) : 0;
    // A manual magnitude limit is absolute (plan Q43): the fade applies only to the fov rule.
    this.starFade = maglimOverride === null ? this.skyB : 0;
    const bg = this.backgroundUniforms;
    bg.tanHalfFov = Math.tan(fovRad / 2);
    bg.aspect = width / height;
    bg.sunAltDeg = sunAltDeg;
    bg.groundAlpha = groundAlpha(options.ground);
    this.background.update(bg);
    this.background.setSkyVisible(atmosphereOn && this.skyB > 0);

    if (this.catalog !== null) {
      const u = this.starUniforms;
      u.horizonQ = current.horizonQ;
      u.observerVelocity = current.observerVelocity;
      u.years = yearsSinceEpoch(tt, this.catalog.columns.epochTt);
      u.refractionOn = this.refractionOn;
      u.refractionFactor = this.refractionFactorValue;
      u.viewportWidth = width;
      u.viewportHeight = height;
      u.fovRad = fovRad;
      this.starMagLimitValue =
        maglimOverride ?? magnitudeLimitForFov(view.fov, this.catalog.magnitudeLimit);
      u.magLimit = this.starMagLimitValue;
      u.pixelScale = pixelScale;
      u.atmosphere = this.starFade;
      this.stars.update(u);
    }
    this.bodies.update(
      current,
      view,
      this.refractionOn,
      this.refractionFactorValue,
      width,
      height,
      fovRad,
      pixelScale,
    );
    if (this.layers.minor) {
      this.minor.update(current, view, this.refractionOn, this.refractionFactorValue);
    }
    this.dsoMagLimitValue = dsoMagnitudeLimit(view.fov, maglimOverride);
    this.dsoSizeLimitValue = dsoSizeLimitArcmin(view.fov);
    if (this.layers.dso) {
      const d = this.dsoUniforms;
      d.horizonQ = current.horizonQ;
      d.observerVelocity = current.observerVelocity;
      d.refractionOn = this.refractionOn;
      d.refractionFactor = this.refractionFactorValue;
      d.viewportWidth = width;
      d.viewportHeight = height;
      d.fovRad = fovRad;
      d.magLimit = this.dsoMagLimitValue;
      d.sizeLimitArcmin = this.dsoSizeLimitValue;
      d.pixelScale = pixelScale;
      d.atmosphere = this.starFade;
      this.dso.update(d);
    }

    if (nowMs - this.lastOverlayMs >= OVERLAY_INTERVAL_MS) {
      this.lastOverlayMs = nowMs;
      this.overlayTick(nowMs);
    }
    if (publishNow) {
      this.publishReadout(state.actions);
    }
  }

  /** The <= 10 Hz work: rotating lines, constellations, labels, marker, follow, centring. */
  private overlayTick(nowMs: number): void {
    const current = this.current;
    const { view, options } = this;
    const { actions } = this.store.getState();
    this.lines.updateDynamic(current);
    this.constellations.update(current, this.refractionOn, this.refractionFactorValue);
    if (
      this.labelsDirty ||
      current.bodyIds !== this.labelsBodies ||
      current.minorIds !== this.labelsMinor
    ) {
      this.rebuildLabels();
    }
    const t = this.labelTick;
    t.frame = current;
    t.view = view;
    t.width = this.canvas.clientWidth;
    t.height = this.canvas.clientHeight;
    t.refractionOn = this.refractionOn;
    t.refractionFactor = this.refractionFactorValue;
    t.cullBelowHorizon = options.ground === 'opaque';
    t.starMagLimit = this.starMagLimitEffective();
    t.dsoMagLimit = this.dsoMagLimitEffective();
    t.dsoSizeLimitArcmin = this.dsoSizeLimitValue;
    this.labels.update(t);
    this.stats.dso = this.layers.dso
      ? this.dso.countVisible(this.dsoMagLimitEffective(), this.dsoSizeLimitValue)
      : 0;
    this.stats.clinesSegments = this.constellations.segmentCount;

    // Follow mode (VIEW-4): the camera re-centres on the selection.
    const selection = this.selection;
    if (
      this.follow &&
      selection !== null &&
      this.resolver.directionOf(selection, this.scratchEnu)
    ) {
      const e = this.scratchEnu;
      enuToAltAz(this.scratchAltAz, e[0], e[1], e[2]);
      actions.setView({ az: this.scratchAltAz.az, alt: this.scratchAltAz.alt });
    }
    // A centre request (search, INFO-2) is served as soon as its object resolves, dropped after
    // ten seconds or once the selection moved elsewhere.
    const centre = this.centre;
    if (centre !== null) {
      if (
        nowMs - centre.sinceMs > CENTRE_TIMEOUT_MS ||
        (selection !== null && selection !== centre.id && !centre.id.startsWith('con:'))
      ) {
        this.centre = null;
        actions.clearCentre(centre.seq);
      } else if (this.resolver.directionOf(centre.id, this.scratchEnu)) {
        const e = this.scratchEnu;
        enuToAltAz(this.scratchAltAz, e[0], e[1], e[2]);
        actions.setView({ az: this.scratchAltAz.az, alt: this.scratchAltAz.alt });
        this.centre = null;
        actions.clearCentre(centre.seq);
      }
    }
    this.labels.publishIfChanged(nowMs, actions);
  }

  private rebuildLabels(): void {
    const current = this.current;
    const r = this.labelRebuild;
    r.catalog = this.catalog;
    r.bundle = this.bundle;
    r.frame = current;
    r.density = this.options.labels;
    r.layers = this.layers;
    r.selection = this.selection;
    this.labels.rebuild(r);
    this.labelsDirty = false;
    this.labelsBodies = current.bodyIds;
    this.labelsMinor = current.minorIds;
  }

  /** The 2 Hz readout of the selection (plan D106): a fresh copy so React sees a change. */
  private publishReadout(actions: Pick<SkyActions, 'publishReadout'>): void {
    const selection = this.selection;
    if (selection !== null && this.resolver.readoutOf(selection, this.readout)) {
      actions.publishReadout({ ...this.readout });
      this.readoutPublished = true;
    } else if (this.readoutPublished) {
      actions.publishReadout(null);
      this.readoutPublished = false;
    }
  }

  private applyView(view: ViewState): void {
    this.view = view;
    cameraRotationFor(this.rotation, view.az, view.alt);
    this.camera.rotation.set(this.rotation[0], this.rotation[1], this.rotation[2]);
    this.camera.fov = view.fov * DEG;
  }

  private applyLayers(layers: LayerFlags): void {
    this.layers = layers;
    // Everything that depends on the horizon rotation waits for the first frame window.
    this.stars.setVisible(layers.stars && this.hasFrame);
    this.bodies.setVisible(layers.planets);
    this.minor.setVisible(layers.minor && this.hasFrame);
    this.dso.setVisible(layers.dso && this.hasFrame);
    this.lines.setVisibility(layers, this.hasFrame);
    this.constellations.setVisibility(layers, this.hasFrame);
    this.labelsDirty = true;
  }

  private applyOptions(options: Options): void {
    const previous = this.options;
    this.options = options;
    this.updateRefraction();
    if (
      options.night !== previous.night ||
      options.nightLevel !== previous.nightLevel ||
      !this.hasFrame
    ) {
      const level = options.night ? options.nightLevel : 1;
      this.stars.setNight(options.night, level);
      this.bodies.setNight(options.night, level);
      this.dso.setNight(options.night, level);
      this.background.setNight(options.night, level);
      this.lines.setNight(options.night, level);
      this.constellations.setNight(options.night, level);
    }
    this.background.setGroundVisible(options.ground !== 'off');
    if (options.labels !== previous.labels || options.lang !== previous.lang) {
      this.labelsDirty = true;
    }
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
      const minorCapacity = meta.limits.max_minor_bodies;
      if (capacity > this.current.mag.length || minorCapacity > this.current.minorMag.length) {
        this.current = createFrameEval(capacity, minorCapacity);
        this.resolver.setFrame(this.current);
      }
      this.bodies.setCapacity(meta.bodies.length);
      this.minor.setCapacity(minorCapacity);
    }
    this.updateCoverage();
  }

  private applyDsoTypes(types: readonly DsoType[] | null): void {
    this.dso.setTypeFilter(types);
  }

  private applyBundle(bundle: CatalogBundle | null): void {
    this.bundle = bundle;
    this.resolver.setBundle(bundle);
    this.dso.setEntries(bundle?.dso?.data ?? null);
    this.constellations.setData(bundle?.constellations?.data ?? null, this.catalog);
    this.constellations.setVisibility(this.layers, this.hasFrame);
    this.constellations.setHighlight(this.store.getState().details.con);
    this.labelsDirty = true;
  }

  /** Minor-body display names from the window status and the server defaults (labels). */
  private applyMinorNames(
    minor: readonly MinorStatus[],
    defaults: readonly MinorBodySummary[] | null,
  ): void {
    this.minorNames.clear();
    if (defaults !== null) {
      for (const summary of defaults) {
        this.minorNames.set(summary.id, summary.name ?? summary.designation);
      }
    }
    for (const status of minor) {
      if (status.name !== undefined) {
        this.minorNames.set(status.id, status.name);
      }
    }
    this.labelsDirty = true;
  }

  /** Refraction applies on Earth only (SKY-7), with the standard pressure at the elevation. */
  private updateRefraction(): void {
    this.refractionOn = this.options.refr && this.observer.body === 'earth';
    this.refractionFactorValue = refractionFactor(this.observer.elev);
    this.resolver.setRefraction(this.refractionOn, this.refractionFactorValue);
  }

  /** `/meta.coverage.ephemeris_tt` intersected with the observer's `coverage_tt` (plan D75, D96). */
  private updateCoverage(): void {
    const range = observerCoverage(this.meta, this.observer.body);
    this.coverage = range === null ? null : [range[0], range[1]];
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

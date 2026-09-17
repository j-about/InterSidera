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
// Augmented reality (plan D116, D122-D124): the engine hosts the lazily imported sensor-mode
// controller (`sky/ar/arController.ts`, loaded when `ar.mode` becomes `requesting`, ticked after
// the other tickers, disposed on `off`), clears the scene transparent over the camera video in the
// underlay, hides the sky and ground quads, stops the horizon culling, the follow and the centring,
// writes `view.fov` from the camera-field model on a frame, field or size change (deferred to the
// next tick, never from inside a store listener) and draws the video under the PNG export.
// WebXR (plan D128-D130): `preloadXr`/`enterXr`/`exitXr` are the event-time calls of the same
// seam; the lazy `./xr/XrBridge` chunk (the Babylon XR set, the bridge and the store flow) is
// imported on demand, the flow owns the store transitions, the bridge corrects the XR rig in
// `tick` and the engine only restores its camera and canvas when a session ends.

import { shallow } from 'zustand/vanilla/shallow';

import type { CatalogBundle } from '../../api/catalogs';
import { ttAt } from '../../state/clock';
import { observerCoverage } from '../../state/coverage';
import type { MetaResponse, MinorBodySummary, SkyActions, SkyStore } from '../../state/storeTypes';
import { createFrameEval, createSelectionReadout } from '../../state/types';
import type {
  AdapterInfo,
  ArMode,
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
import { coverCropRect, visibleVerticalFovDeg } from '../math/cameraFov';
import type { CropRect } from '../math/cameraFov';
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
import type { XrFlow } from './xr/xrFlow';
import type {
  ArController,
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

/** The lazy WebXR chunk (`sky/engine/xr/`): the Babylon XR set, the bridge and the store flow. */
type XrModule = typeof import('./xr/XrBridge');

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
  /** The AR video host of plan D121 (the AR controller owns its contents). */
  readonly underlayRoot: HTMLElement;

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
  /** Camera roll in degrees (`ar.roll`, plan D119): 0 outside AR, applied through frames.ts. */
  private roll = 0;
  /** Mirror of `ar.mode` (plan D124); every AR rule below reads it. */
  private arMode: ArMode = 'off';
  /** The lazily imported sensor-mode controller (plan D116), alive while `ar.mode !== 'off'`. */
  private arController: ArController | null = null;
  /** Bumped on every mode change: a `startAr` that awaited the chunk under an older value stops. */
  private arSeq = 0;
  /** `view.fov` must be recomputed from the camera model at the next tick (plan D123). */
  private arFovDirty = false;
  /** `setVisibleLabels([])` is owed at the next overlay tick (XR entry, plan D124). */
  private labelsClearPending = false;
  /** The lazy WebXR chunk, loaded once (`preloadXr`, plan D128, R86); reset after a failed load. */
  private xrModule: Promise<XrModule> | null = null;
  /** The WebXR flow (store transitions) and, inside it, the Babylon bridge; created on the first tap. */
  private xr: XrFlow | null = null;
  private readonly clearOpaque = new Color4(0, 0, 0, 1);
  private readonly clearTransparent = new Color4(0, 0, 0, 0);
  private readonly cropRect: CropRect = { sx: 0, sy: 0, sw: 0, sh: 0 };
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
    this.underlayRoot = options.underlayRoot;
    this.signal = options.signal;
    this.readyPromise = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });

    const scene = new Scene(this.engine);
    scene.autoClear = true;
    // Opaque black outside AR; the transparent twin shows the camera video (plan D122).
    scene.clearColor = this.clearOpaque;
    // Every sky mesh is always active (brief l.545): no per-frame frustum work.
    scene.skipFrustumClipping = true;
    // The Scene constructor attaches Babylon's input manager; the camera controller owns the
    // DOM events instead (plan D81, D85).
    scene.detachControl();
    this.scene = scene;

    this.camera = new TargetCamera('sky-camera', Vector3.Zero(), scene);
    this.camera.minZ = CAMERA_MIN_Z;
    this.camera.maxZ = CAMERA_MAX_Z;
    // The roll (`rotation.z = -ar.roll`, plan D119) reaches the view matrix through the up
    // vector, which `TargetCamera` otherwise refreshes only when `rotation.z` itself changes: a
    // yaw or pitch change under a fixed roll would render a stale roll. With roll 0 the picture
    // is today's (the rotated up vector lies in the vertical plane of the view direction).
    this.camera.updateUpVectorFromRotation = true;

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
      roll: 0,
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

    // Created before the subscriptions: every `fireImmediately` callback below runs inside this
    // constructor, and `applyArMode` reaches `this.controller.setDragMode` whenever the store is
    // not in `off` (the AR button is live while the engine still boots). Its constructor reads
    // only the canvas, the store and `matchMedia`; the pick closure defers `this.pick`.
    this.controller = new CameraController(options.canvas, this.store, (x, y) => this.pick(x, y));

    // Store -> engine (plan D80): selector subscriptions, fired once for the initial state. Every
    // field a callback touches (the camera, the layers, the resolver, `labelRoot`, `controller`,
    // the mirrored `view` and `options`) exists above this line.
    this.unsubscribe.push(
      this.store.subscribe(
        (s) => s.view,
        (view) => {
          this.applyView(view);
        },
        { equalityFn: shallow, fireImmediately: true },
      ),
      // `setArPose` writes `view` and `ar.roll` in one `set`; both listeners re-apply the camera
      // (cheap: three Euler angles) so the order they fire in does not matter.
      this.store.subscribe(
        (s) => s.ar.roll,
        (roll) => {
          this.roll = roll;
          this.applyView(this.view);
        },
        { fireImmediately: true },
      ),
      // Augmented reality (plan D116, D124): the mode drives the controller's life and the visuals;
      // the frame size and the camera field make `view.fov` dirty (written in the next tick).
      this.store.subscribe(
        (s) => s.ar.mode,
        (mode) => {
          this.applyArMode(mode);
        },
        { fireImmediately: true },
      ),
      this.store.subscribe(
        (s) => s.ar.frame,
        () => {
          this.arFovDirty = true;
        },
      ),
      this.store.subscribe(
        (s) => s.ar.cameraFovDeg,
        () => {
          this.arFovDirty = true;
        },
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
    // In an XR session the DOM overlay covers the canvas (plan D124, backlog B-80).
    if (this.arMode === 'xr' || !current.valid || width <= 0 || height <= 0) {
      return null;
    }
    const { view } = this;
    const q = current.horizonQ;
    const tapEnu = this.scratchEnu;
    const tapIcrf = this.scratchIcrf;
    screenToDirection(
      this.scratchAltAz,
      xCss,
      yCss,
      width,
      height,
      view.fov,
      view.az,
      view.alt,
      this.roll,
    );
    altAzToEnu(tapEnu, this.scratchAltAz.alt, this.scratchAltAz.az);
    rotateInverse(tapIcrf, q, tapEnu);
    const tolDeg = pickToleranceDeg(PICK_TOLERANCE_PX, view.fov, height);
    const cosCone = coneCosine(tolDeg);
    const cullBelow = this.cullBelowHorizon();
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
      !directionToScreen(
        screen,
        altAz.alt,
        altAz.az,
        width,
        height,
        view.fov,
        view.az,
        view.alt,
        this.roll,
      )
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
   * false) onto a 2D canvas of the same size, the label overlay composited with `fillText`. In
   * the sensor AR mode the camera video is drawn first (plan D122); during a WebXR session the
   * canvas is Babylon's XR framebuffer, so the export is refused (plan D124, backlog B-80).
   */
  snapshot(): Promise<Blob> {
    if (this.disposed || this.store.getState().engine.status === 'failed') {
      return Promise.reject(new Error('the sky engine is not running'));
    }
    if (this.arMode === 'xr') {
      return Promise.reject(new Error('no snapshot during a WebXR session'));
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
          const cssWidth = source.clientWidth > 0 ? source.clientWidth : source.width;
          const cssHeight = source.clientHeight > 0 ? source.clientHeight : source.height;
          // AR (plan D122): the camera video first, cropped as `object-fit: cover` shows it in
          // the canvas box, so every premultiplied star pixel lands on an opaque background.
          const video = this.arController?.video() ?? null;
          if (video !== null && video.videoWidth > 0 && video.videoHeight > 0) {
            const crop = coverCropRect(
              this.cropRect,
              video.videoWidth,
              video.videoHeight,
              cssWidth,
              cssHeight,
            );
            ctx.drawImage(
              video,
              crop.sx,
              crop.sy,
              crop.sw,
              crop.sh,
              0,
              0,
              target.width,
              target.height,
            );
          }
          ctx.drawImage(source, 0, 0);
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

  /**
   * Load the WebXR chunk ahead of the tap (plan D128, R86: the transient activation must not
   * span a download); the controller calls it once `ar.xr.support` is `supported`.
   */
  preloadXr(): Promise<void> {
    return this.loadXr().then(() => undefined);
  }

  private loadXr(): Promise<XrModule> {
    if (this.xrModule === null) {
      const loading = import('./xr/XrBridge');
      this.xrModule = loading;
      void loading.catch(() => {
        // Offline or a stale deployment: the next tap retries the download.
        if (this.xrModule === loading) {
          this.xrModule = null;
        }
      });
    }
    return this.xrModule;
  }

  /**
   * Event-time entry into an `immersive-ar` session (plan D93, D128): allowed from the sensor
   * mode with `xr.support === 'supported'` and an idle phase; the phase turns `entering` at once,
   * the chunk is awaited (a failed load is the one failure classified here: `xrFailed`), then the
   * flow creates the bridge, enters and writes the outcome (`setArMode('xr')` and `active`, or
   * `failAr(code)` keeping the sensor mode; an `AbortError` stays silent). The promise settles
   * with the flow's.
   */
  async enterXr(overlay: HTMLElement): Promise<void> {
    // Read through a function: TypeScript keeps the narrowing of `this.disposed` across `await`.
    const disposed = (): boolean => this.disposed;
    if (disposed()) {
      throw abortError();
    }
    const { ar, actions } = this.store.getState();
    if (ar.mode !== 'sensor' || ar.xr.support !== 'supported' || ar.xr.phase !== 'idle') {
      throw new Error('WebXR cannot start in this state');
    }
    actions.setArXr({ phase: 'entering' });
    let mod: XrModule;
    try {
      mod = await this.loadXr();
    } catch (error: unknown) {
      if (!disposed()) {
        console.error('the WebXR chunk could not be loaded', error);
        this.store.getState().actions.failAr('xrFailed');
      }
      throw error;
    }
    if (disposed()) {
      throw abortError();
    }
    this.xr ??= new mod.XrFlow({
      store: this.store,
      createBridge: (hooks) => mod.XrBridge.create(this.scene, this.camera, this.store, hooks),
      onSessionEnded: () => {
        this.afterXrSession();
      },
    });
    await this.xr.enter(overlay);
  }

  /** End the session (the overlay's control); the store returns to the sensor mode on its end. */
  exitXr(): Promise<void> {
    return this.xr?.exit() ?? Promise.resolve();
  }

  /**
   * A session ended (plan D124, R87): the store already reads `sensor` (or `off`), so the sky
   * camera is the active one again; re-apply the view it should show and the canvas size Babylon
   * reset to DPR 1.
   */
  private afterXrSession(): void {
    if (this.disposed) {
      return;
    }
    this.applyView(this.view);
    this.resize();
  }

  arTransparent(): boolean {
    return this.scene.clearColor.a === 0;
  }

  /**
   * Match the canvas to its CSS size at up to 2 device pixels per CSS pixel (plan D85). Skipped
   * during a WebXR session (the XR framebuffer renders; Babylon sizes the canvas itself) and run
   * once when the session ends (`afterXrSession`).
   */
  resize(): void {
    if (this.disposed || this.arMode === 'xr') {
      return;
    }
    const ratio = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
    this.engine.setHardwareScalingLevel(1 / Math.min(ratio, MAX_DEVICE_PIXEL_RATIO));
    this.engine.resize();
    // The visible part of the camera frame changed with the box (plan D123).
    this.arFovDirty = true;
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
    this.arSeq += 1;
    // The XR bridge first: an open session ends before the scene it renders goes away.
    this.xr?.dispose();
    this.xr = null;
    this.arController?.dispose();
    this.arController = null;
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
    // The AR controller writes `setArPose` here (plan D116); the view subscription applies it
    // to the camera before `scene.render`, in this same tick.
    this.arController?.update(tt, nowMs);
    // In a WebXR session the bridge corrects the rig cameras Babylon just posed and publishes the
    // pose (plan D130) before the layers below read `view` and the roll; a no-op otherwise.
    this.xr?.tick();
    if (this.arFovDirty) {
      this.arFovDirty = false;
      this.applyArFov(state.actions);
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
    cameraBasis(this.camForward, this.camRight, this.camUp, view.az, view.alt, this.roll);
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
    // No sky quad over the camera video (plan D124); the daylight fade of the stars is kept.
    this.background.setSkyVisible(atmosphereOn && this.skyB > 0 && this.arMode === 'off');

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
      this.roll,
    );
    if (this.layers.minor) {
      this.minor.update(current, view, this.refractionOn, this.refractionFactorValue, this.roll);
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
    const { view } = this;
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
    t.cullBelowHorizon = this.cullBelowHorizon();
    t.starMagLimit = this.starMagLimitEffective();
    t.dsoMagLimit = this.dsoMagLimitEffective();
    t.dsoSizeLimitArcmin = this.dsoSizeLimitValue;
    t.roll = this.roll;
    const inXr = this.arMode === 'xr';
    if (inXr) {
      // The DOM outside the overlay is not rendered in a session (plan D124, backlog B-80): the
      // label root is hidden and the visible-label list is emptied once.
      if (this.labelsClearPending) {
        this.labelsClearPending = false;
        actions.setVisibleLabels([]);
      }
    } else {
      this.labels.update(t);
    }
    this.stats.dso = this.layers.dso
      ? this.dso.countVisible(this.dsoMagLimitEffective(), this.dsoSizeLimitValue)
      : 0;
    this.stats.clinesSegments = this.constellations.segmentCount;

    // Follow and centring write the view: both are suspended while the sensors or the XR rig own
    // it (plan D124; `requestAr` ends follow, a centre request waits or times out).
    if (this.arMode === 'off') {
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
    }
    if (!inXr) {
      this.labels.publishIfChanged(nowMs, actions);
    }
  }

  /** `ground === 'opaque'` hides what lies below the horizon, except over the camera video (plan D124). */
  private cullBelowHorizon(): boolean {
    return this.options.ground === 'opaque' && this.arMode === 'off';
  }

  /**
   * `ar.mode` changed (plan D116, D124): `requesting` loads and starts the controller, `off`
   * disposes it; the camera controller's drag becomes the AR-3 offset in the sensor mode; the
   * visuals follow. Runs inside the store listener, so nothing here writes the store.
   */
  private applyArMode(mode: ArMode): void {
    const previous = this.arMode;
    if (mode === previous) {
      return;
    }
    this.arMode = mode;
    this.arSeq += 1;
    if (mode === 'requesting') {
      void this.startAr(this.arSeq);
    } else if (mode === 'off') {
      this.arController?.dispose();
      this.arController = null;
      // Escape, the exit control or a hidden page while a WebXR session runs or starts: the
      // session ends (the flow awaits a pending entry first); nothing is written here.
      void this.xr?.exit();
    }
    // Offset drag in the sensor mode only: in `requesting` the controller's entry rule discards
    // any offset (a headed source resets it, a relative one derives it from `view.az`), so the
    // view drag is the harmless one; in `xr` the DOM overlay owns the pointer (`offsetDrag.ts`).
    this.controller.setDragMode(mode === 'sensor' ? 'offset' : 'view');
    this.applyArVisuals(mode, previous);
    this.arFovDirty = true;
  }

  /** Load the AR chunk and start the controller unless the mode moved on meanwhile (plan D116). */
  private async startAr(seq: number): Promise<void> {
    let createArController: typeof import('../ar/arController').createArController;
    try {
      ({ createArController } = await import('../ar/arController'));
    } catch (error: unknown) {
      if (seq === this.arSeq && !this.disposed) {
        // Offline or a stale deployment: the one AR-5 code that fits "AR could not start".
        console.error('the augmented-reality chunk could not be loaded', error);
        this.store.getState().actions.failAr('cameraUnavailable');
      }
      return;
    }
    if (seq !== this.arSeq || this.disposed || this.store.getState().ar.mode !== 'requesting') {
      return;
    }
    this.arController = createArController({
      store: this.store,
      underlayRoot: this.underlayRoot,
      preloadXr: () => this.preloadXr(),
    });
  }

  /**
   * The Babylon-side rules of plan D124: a transparent clear over the video, no sky or ground
   * quad (the store's `options` untouched; `applyOptions` and `tick` restore them on exit), the
   * label root hidden during an XR session with the visible-label list emptied at the next tick.
   * They hold from `requesting` on, as D124 reads (`ar.mode !== 'off'`): during the permission
   * prompts, before any video plays, the sky is drawn over the page background (`--color-sky-bg`,
   * a near-black for a few seconds) instead of the opaque clear. Accepted: the AR chrome, the
   * transparent scene and the debug hook's `arTransparent()` switch together on one rule.
   */
  private applyArVisuals(mode: ArMode, previous: ArMode): void {
    const active = mode !== 'off';
    this.scene.clearColor = active ? this.clearTransparent : this.clearOpaque;
    this.background.setGroundVisible(!active && this.options.ground !== 'off');
    if (active) {
      this.background.setSkyVisible(false);
    }
    const inXr = mode === 'xr';
    if (inXr !== (previous === 'xr')) {
      this.labelRoot.hidden = inXr;
      this.labelsClearPending = inXr;
      if (!inXr) {
        // The store's list was emptied by the engine in the session: publish the drawn set again.
        this.labels.resetPublished();
        this.labelsDirty = true;
      }
    }
  }

  /**
   * AR-2 field matching (plan D123): while the sensor mode runs and the frame size is known,
   * `view.fov` is the vertical field the camera model gives for the frame shown `object-fit:
   * cover` in the canvas box (the third engine-side `setView` context beside follow and
   * centring). The XR bridge owns `view.fov` during a session.
   */
  private applyArFov(actions: Pick<SkyActions, 'setView'>): void {
    const { ar, view } = this.store.getState();
    if (ar.mode === 'off' || ar.mode === 'xr' || ar.frame === null) {
      return;
    }
    const fov = visibleVerticalFovDeg(
      ar.cameraFovDeg,
      ar.frame.width,
      ar.frame.height,
      this.canvas.clientWidth,
      this.canvas.clientHeight,
      view.fov,
    );
    if (fov !== view.fov) {
      actions.setView({ fov });
    }
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
    cameraRotationFor(this.rotation, view.az, view.alt, this.roll);
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
    this.background.setGroundVisible(options.ground !== 'off' && this.arMode === 'off');
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

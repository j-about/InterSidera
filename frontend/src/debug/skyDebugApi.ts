// Shape of `window.__sky`, the debug hook of dev and e2e builds (brief l.410, plan D86).
// Types only. This file is a leaf reached from the Playwright specs (tsconfig.node.json), so it
// imports nothing but the leaf `state/types.ts`, with an explicit extension.

import type {
  AdapterInfo,
  ArCapabilities,
  ArError,
  ArFrameSize,
  ArHeading,
  ArMode,
  ArPermission,
  ArXrState,
  Backend,
  ClockMode,
  DialogId,
  FramesState,
  FrameWindowInfo,
  GeoStatus,
  LabelKind,
  LayerFlags,
  Observer,
  PanelId,
  ViewState,
} from '../state/types.ts';

/** The `ar` slice as the hook mirrors it (plan D115), plus what only the engine knows. */
export interface SkyDebugArState {
  mode: ArMode;
  permission: ArPermission;
  capabilities: ArCapabilities | null;
  error: ArError | null;
  heading: ArHeading;
  azOffsetDeg: number;
  cameraFovDeg: number;
  frame: ArFrameSize | null;
  roll: number;
  /** `viewBefore.fov`, the field of view the exit restores; `null` outside AR. */
  viewBeforeFov: number | null;
  /** The scene is cleared transparent (`SkyEngineApi.arTransparent`). */
  transparent: boolean;
  xr: ArXrState;
}

export interface SkyDebugState {
  tt: number;
  mode: ClockMode;
  speed: number;
  /** Rendered local apparent sidereal time in hours, `NaN` off Earth or before the first frame. */
  lstHours: number;
  observer: Observer;
  view: ViewState;
  frame: FrameWindowInfo | null;
  /** The coverage range the clock was stopped at (TIME-4), `null` when running freely. */
  coverageStop: readonly [number, number] | null;
  /** Client-side refraction toggle (Earth only). */
  refr: boolean;
  catalogs: { stars: number; index: number; dso: number; constellations: number };
  /** SKYS parse and HIP-index time in milliseconds (`StarCatalogInput.parseMs`), `null` before the catalog arrived. */
  parseMs: number | null;
  /** `/catalogs/stars` download time in milliseconds (`StarCatalogInput.fetchMs`), `null` before it arrived. */
  fetchMs: number | null;
  /**
   * `Date.now()` as the last render tick read it (plan D141): `state().tt` was derived from this
   * instant, so `Date.now() - tickWallMs` is the frame staleness and, in live mode,
   * `(tt - 2440587.5) * 86400000 - ttMinusUtc * 1000 === tickWallMs` to float64 precision.
   */
  tickWallMs: number;
  /** `clock.ttMinusUtc`, seconds (`/meta.server_time.tt_minus_utc_seconds`; `NaN` before `/meta`). */
  ttMinusUtc: number;
  /** The store's `frames.failing` as it is (a transient frame failure being retried, UX-6). */
  failing: FramesState['failing'];
  geo: GeoStatus;
  /** The selection (`sel`). */
  sel: string | null;
  night: boolean;
  nightLevel: number;
  layers: LayerFlags;
  /** `prefers-reduced-motion` as the page sees it. */
  reducedMotion: boolean;
  ui: { panel: PanelId | null; sheet: 'collapsed' | 'expanded'; dialog: DialogId | null };
  ar: SkyDebugArState;
}

/** A label on screen: its CSS-pixel box relative to the canvas. */
export interface SkyDebugLabel {
  id: string;
  kind: LabelKind;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Degrees. `alt` is what the engine renders (refracted when refraction applies), `altTrue` the geometric altitude. */
export interface SkyDebugAltAz {
  alt: number;
  altTrue: number;
  az: number;
}

/** The boot marks and the document's navigation timing (plan D141), milliseconds since `timeOrigin`. */
export interface SkyDebugTiming {
  /** `performance.timeOrigin`, Unix milliseconds. */
  timeOrigin: number;
  /**
   * Every `sky:*` mark (`state/boot.ts` phases, `sky:engine-ready`) by name, the last occurrence
   * when a phase was marked twice (an API still `starting` loops the boot back through `/health`
   * once, plan D138); empty without the Performance Timeline.
   */
  marks: Record<string, number>;
  /** Navigation Timing Level 2 of the document; `null` without the entry. */
  navigation: {
    responseEnd: number;
    domInteractive: number;
    domContentLoadedEventEnd: number;
    loadEventEnd: number;
    transferSize: number;
  } | null;
}

/** One Resource Timing row (plan D137: the download and the 304 second load are asserted on it). */
export interface SkyDebugResource {
  /** The URL without the page origin (`/api/v1/catalogs/stars`, `/assets/index-....js`). */
  name: string;
  initiatorType: string;
  /** Bytes on the wire incl. headers; about 300 for a 304 revalidation, 0 when served from the cache. */
  transferSize: number;
  encodedBodySize: number;
  decodedBodySize: number;
  startTime: number;
  responseEnd: number;
}

/** Sums of `transferSize` over the Resource Timing rows plus the document (plan D141 `download`). */
export interface SkyDebugDownload {
  totalBytes: number;
  /** `/api/v1/catalogs/*`. */
  catalogsBytes: number;
  /** Every `/api/` row (catalogs included). */
  apiBytes: number;
  /** Everything else (scripts, styles, icons). */
  assetBytes: number;
  resources: number;
}

/** Result of `selfTest()`: the numbers docs/testing.md records for a real-browser run (plan step 5, D141). */
export interface SkyDebugReport {
  backend: Backend;
  adapterInfo: AdapterInfo | null;
  userAgent: string;
  viewport: { width: number; height: number; devicePixelRatio: number };
  /** The device ratio, the cap in force and the render target (plan D142). */
  dpr: {
    device: number;
    cap: number;
    hardwareScalingLevel: number;
    renderWidth: number;
    renderHeight: number;
  };
  hardwareConcurrency: number;
  /** `navigator.deviceMemory` in GiB (Chromium only), `null` elsewhere. */
  deviceMemory: number | null;
  tt: number;
  observer: Observer;
  refr: boolean;
  stars: number;
  parseMs: number | null;
  fetchMs: number | null;
  /** Rendering time the frame-rate figure covers, seconds. */
  seconds: number;
  fps: number;
  frameMs: number;
  /** Mean tick, render and overlay-tick cost over the window, milliseconds. */
  phases: { tickMs: number; renderMs: number; overlayMs: number };
  /** Frames and overlay ticks completed during the window. */
  frames: number;
  overlayTicks: number;
  /** Largest `Date.now() - tickWallMs` sampled during the window (about one frame period), ms. */
  staleMs: number;
  timing: SkyDebugTiming;
  download: SkyDebugDownload;
  /** Polaris (HIP 11767) altitude against the latitude, within 1 degree when `ok`. */
  polaris: { alt: number; lat: number; ok: boolean } | null;
  /** Rendered direction of every body against `/sky/altaz` at the same instant and refraction. */
  bodies: { id: string; sepArcmin: number }[];
  maxSepArcmin: number | null;
}

export interface SkyDebugApi {
  readonly backend: Backend;
  /** `true` once the catalog and the first frame window are rendered. */
  readonly isReady: boolean;
  /** Resolves when `isReady` becomes true. */
  readonly ready: Promise<void>;
  readonly adapterInfo: AdapterInfo | null;
  /** Frames per second over the last ten seconds of rendering. */
  fps(): number;
  state(): SkyDebugState;
  /**
   * The direction the engine currently renders for a body id (`mars`, `moon`, ...) or a star
   * (`hip:11767`), computed on the CPU with the same rules as the shaders; `null` when unknown.
   */
  altAzOf(id: string): SkyDebugAltAz | null;
  /** Screen position in CSS pixels of the same target, `null` when behind the camera. */
  screenOf(id: string): { x: number; y: number } | null;
  /** Pause at a TT Julian Date. */
  setTime(tt: number): void;
  pause(): void;
  play(speed: number): void;
  live(): void;
  setView(az: number, alt: number, fov?: number): void;
  setRefraction(on: boolean): void;
  /** Resolves once a frame window covering the current time has been rendered. */
  waitForFrame(): Promise<void>;
  /**
   * Resolves after `n` further render frames have completed (plan D140): after a `setView`, two
   * frames guarantee the new picture has been presented, so a pixel probe reads it without a
   * wall-clock wait. Rejects when the engine is disposed or gave up.
   */
  afterFrames(n: number): Promise<void>;
  /**
   * The boot marks and the navigation timing; empty marks and a `null` navigation without the
   * Performance Timeline (`getEntriesByType`, `PerformanceNavigationTiming`), never a throw.
   */
  timing(): SkyDebugTiming;
  /** The Resource Timing rows of this document; empty without `performance.getEntriesByType`. */
  resources(): SkyDebugResource[];
  stats(): {
    stars: number;
    frameMs: number;
    /** Deep-sky objects drawn (computed on demand, plan D144). */
    dso: number;
    /** Constellation line segments built from the catalog (both HIP ends resolved); `layers.clines` says whether they are drawn. */
    clinesSegments: number;
    /** IAU abbreviation of the highlighted constellation (`details.con`), `null` when none. */
    clinesHighlight: string | null;
    /** Constellation boundary chords built from the catalog; `layers.cbounds` says whether they are drawn. */
    cboundsSegments: number;
    /** Minor bodies of the current window with samples (drawn). */
    minorDrawn: number;
    /** Completed render frames since the engine was created (monotonic). */
    frames: number;
    /** Overlay ticks (the <= 10 Hz path) since the engine was created (monotonic). */
    overlayTicks: number;
    /** `setVisibleLabels` publications since the engine was created (monotonic, <= 1 Hz). */
    labelPublishes: number;
    /** Mean cost per phase over the last ten seconds, milliseconds. */
    tickMs: number;
    renderMs: number;
    overlayMs: number;
    /**
     * The backing store in device pixels (`EnginePerf.renderTarget()`: the canvas box times the
     * DPR cap in force, plan D142); the exported PNG's IHDR equals it (`csp.spec.ts` (c)).
     */
    renderWidth: number;
    renderHeight: number;
  };
  /** The object under a CSS-pixel position of the canvas, `null` when none. */
  pick(x: number, y: number): string | null;
  /** The labels currently drawn, with their boxes. */
  labels(): SkyDebugLabel[];
  /** IAU abbreviation of the constellation holding `id`, `null` when unknown. */
  constellationOf(id: string): string | null;
  /** Sky background brightness in `[0, 1]` (0 = night sky, 1 = full daylight). */
  skyBrightness(): number;
  setFollow(on: boolean): void;
  /**
   * The camera video of the AR underlay (`underlayRoot`), `null` when none is attached:
   * `playing` = not paused with at least the current frame decoded (`readyState >= 2`),
   * `width`/`height` the intrinsic size (never hardcoded in a spec, plan R92).
   */
  arVideo(): { playing: boolean; width: number; height: number } | null;
  /**
   * The M3 sanity checks run inside the page (for real-browser runs, docs/testing.md): waits
   * `seconds` (default 10) of rendering after `ready`, then reports the frame rate, the phase
   * costs, the frame staleness, the boot marks, the download and Polaris and every body against
   * `/sky/altaz`. A `selftest` key in the URL hash runs it after `ready` and shows the JSON in an
   * overlay; `report=<url or same-origin path>` also POSTs it there (dev and e2e builds only; plan
   * D168: `report=/__selftest` reaches the local collector through the dev/preview proxy under
   * `connect-src 'self'`).
   */
  selfTest(seconds?: number): Promise<SkyDebugReport>;
}

declare global {
  interface Window {
    __sky?: SkyDebugApi;
  }
}

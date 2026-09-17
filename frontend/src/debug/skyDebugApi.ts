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
  /** SKYS fetch, parse and HIP-index time in milliseconds (`StarCatalogInput.parseMs`), `null` before the catalog arrived. */
  parseMs: number | null;
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

/** Result of `selfTest()`: the numbers docs/testing.md records for a real-browser run (plan step 5). */
export interface SkyDebugReport {
  backend: Backend;
  adapterInfo: AdapterInfo | null;
  userAgent: string;
  viewport: { width: number; height: number; devicePixelRatio: number };
  tt: number;
  observer: Observer;
  refr: boolean;
  stars: number;
  parseMs: number | null;
  /** Rendering time the frame-rate figure covers, seconds. */
  seconds: number;
  fps: number;
  frameMs: number;
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
  stats(): {
    stars: number;
    frameMs: number;
    /** Deep-sky objects drawn. */
    dso: number;
    /** Constellation line segments drawn. */
    clinesSegments: number;
    /** Minor bodies of the current window with samples (drawn). */
    minorDrawn: number;
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
   * `seconds` (default 10) of rendering after `ready`, then reports the frame rate, Polaris and
   * every body against `/sky/altaz`. A `selftest` key in the URL hash runs it after `ready` and
   * shows the JSON in an overlay; `report=<url>` also POSTs it there (dev and e2e builds only).
   */
  selfTest(seconds?: number): Promise<SkyDebugReport>;
}

declare global {
  interface Window {
    __sky?: SkyDebugApi;
  }
}

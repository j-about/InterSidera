// Public seams of the sky engine (plan D80-D86). Babylon-free on purpose: the React shell, the
// frame controller and the debug hook program against these interfaces while `SkyEngine.ts`
// implements them.

import type { SkyStore } from '../../state/storeTypes';
import type {
  AdapterInfo,
  Backend,
  FrameEval,
  LabelKind,
  SelectionReadout,
  StarColumns,
} from '../../state/types';
import type { Vec3 } from '../math/typed';

/** What the engine pulls from the frame buffer on every animation frame. */
export interface FrameSource {
  /** Run the fetch policy for `tt` at wall time `nowMs` (may start or cancel requests). */
  update(tt: number, nowMs: number): void;
  /** Evaluate the loaded window at `tt` into `out` (`out.valid` is false before the first window). */
  evaluate(tt: number, out: FrameEval): void;
  /** Resolves once a window covering `tt` (or, when `tt` is omitted, the current time) is loaded. */
  whenCovering(tt?: number): Promise<void>;
}

/** The parsed star catalog handed to the engine once per session. */
export interface StarCatalogInput {
  columns: StarColumns;
  /** Hipparcos id -> row index. */
  hipIndex: ReadonlyMap<number, number>;
  /** Faintest magnitude of the catalog (`/meta.catalogs.stars.magnitude_limit`). */
  magnitudeLimit: number;
  /**
   * Milliseconds from the start of the `/catalogs/stars` request to the end of parsing and HIP
   * indexing (`api/catalogs.ts`); the GPU upload is not included.
   */
  parseMs: number;
}

/**
 * What a label says (plan D93): the engine imports no i18next, so the shell hands it a resolver
 * (`i18n/labelText.ts`) keyed by kind. Star, DSO and minor-body labels carry their own text.
 */
export type LabelTextKey =
  | { kind: 'constellation'; abbr: string }
  | { kind: 'body'; id: string }
  | { kind: 'cardinal'; letter: 'n' | 'e' | 's' | 'w' };

/** Something the engine pulls on every animation frame after the frame source (plan D93). */
export interface EngineTicker {
  update(tt: number, nowMs: number): void;
}

export interface SkyEngineOptions {
  canvas: HTMLCanvasElement;
  store: SkyStore;
  frames: FrameSource;
  /** The `aria-hidden` sibling of the canvas the labels are drawn into (plan D93). */
  labelRoot: HTMLElement;
  labelText: (key: LabelTextKey) => string;
  /** Pulled by `tick` after `frames.update` (the details controller); none by default. */
  tickers?: readonly EngineTicker[];
  /** Aborting disposes whatever was created (React StrictMode double effect, brief l.551). */
  signal: AbortSignal;
  /** `'auto'` = WebGPU when `WebGPUEngine.IsSupportedAsync` resolves true, else WebGL2. */
  preferBackend: Backend | 'auto';
  /** WebGPU has no post-hoc XR compatibility (M5 threads this through). */
  xrCompatible?: boolean;
  /** Dev and e2e builds: Babylon's missing-side-effect warnings on. */
  debug?: boolean;
}

/** A label the engine draws, with its CSS-pixel box relative to the canvas (debug hook, e2e). */
export interface LabelBox {
  id: string;
  kind: LabelKind;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Counts of the rendering layers after the last overlay tick (debug hook `stats()`). */
export interface LayerStats {
  /** Deep-sky objects passing the limits and the type filter. */
  dso: number;
  /** Constellation line segments with both ends in the star catalog. */
  clinesSegments: number;
}

export interface SkyEngineApi {
  readonly backend: Backend;
  readonly adapterInfo: AdapterInfo | null;
  /** The evaluation rendered by the last animation frame (reused, never copied). */
  readonly current: Readonly<FrameEval>;
  setCatalog(catalog: StarCatalogInput): void;
  currentTt(): number;
  /** Resolves after the catalog and a frame window have been rendered at least once. */
  whenReady(): Promise<void>;
  /** Frames per second over the last ten seconds. */
  fps(): number;
  /** Average CPU time of `tick + render` per frame in milliseconds. */
  frameMs(): number;
  starCount(): number;
  /**
   * The apparent ENU direction the engine renders for an object id (a body, `hip:<n>`), refracted
   * when refraction applies, into `out`; `false` when the object is unknown or not yet evaluated.
   */
  directionOf(id: string, out: Vec3): boolean;
  /** The full readout of an object into `out` (`out.valid` false when unknown). */
  readoutOf(id: string, out: SelectionReadout): boolean;
  /** The object under a CSS-pixel position of the canvas, `null` when none. */
  pick(xCss: number, yCss: number): string | null;
  /** A PNG of the current frame (rejects when disposed, failed or too slow). */
  snapshot(): Promise<Blob>;
  /** The labels currently drawn (a fresh array; dev and e2e hook). */
  labelBoxes(): LabelBox[];
  /** Sky background brightness B in `[0, 1]` of the last frame (0 with the atmosphere off). */
  skyBrightness(): number;
  layerStats(): LayerStats;
  /** `prefers-reduced-motion` as the camera controller honours it (inertia off). */
  reducedMotion(): boolean;
  resize(): void;
  dispose(): void;
}

export type SkyEngineFactory = (options: SkyEngineOptions) => Promise<SkyEngineApi>;

/** Thrown by the factory when neither WebGPU nor WebGL2 is available (UX-6 message). */
export class WebGL2UnavailableError extends Error {
  constructor(message = 'WebGL2 is not available') {
    super(message);
    this.name = 'WebGL2UnavailableError';
  }
}

/** Dependencies of `debug/skyDebug.ts::installSkyDebug` (dev and e2e builds only). */
export interface SkyDebugDeps {
  store: SkyStore;
  engine: SkyEngineApi;
  frames: FrameSource;
  catalog: () => StarCatalogInput | null;
  canvas: HTMLCanvasElement;
}

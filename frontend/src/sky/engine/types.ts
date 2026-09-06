// Public seams of the sky engine (plan D80-D86). Babylon-free on purpose: the React shell, the
// frame controller and the debug hook program against these interfaces while `SkyEngine.ts`
// implements them.

import type { SkyStore } from '../../state/storeTypes';
import type { AdapterInfo, Backend, FrameEval, StarColumns } from '../../state/types';

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

export interface SkyEngineOptions {
  canvas: HTMLCanvasElement;
  store: SkyStore;
  frames: FrameSource;
  /** Aborting disposes whatever was created (React StrictMode double effect, brief l.551). */
  signal: AbortSignal;
  /** `'auto'` = WebGPU when `WebGPUEngine.IsSupportedAsync` resolves true, else WebGL2. */
  preferBackend: Backend | 'auto';
  /** WebGPU has no post-hoc XR compatibility (M5 threads this through). */
  xrCompatible?: boolean;
  /** Dev and e2e builds: Babylon's missing-side-effect warnings on. */
  debug?: boolean;
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

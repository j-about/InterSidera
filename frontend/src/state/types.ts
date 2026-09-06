// Shared state types (plan D80). This is a leaf module: it imports only the pure tuple types,
// so `debug/skyDebugApi.ts` and the Playwright specs (type-checked by tsconfig.node.json) can
// reach it without dragging the store, the API schema or Babylon along.

import type { Quat, Vec3 } from '../sky/math/typed.ts';

export type Backend = 'webgpu' | 'webgl2';

/** `GPUAdapterInfo` fields exposed by the debug hook (WebGPU only). */
export interface AdapterInfo {
  vendor: string;
  architecture: string;
  description: string;
}

/** The observer of the URL (`body`, `lat`, `lon`, `elev`): degrees and metres, unrounded. */
export interface Observer {
  body: string;
  lat: number;
  lon: number;
  elev: number;
}

export type ClockMode = 'live' | 'paused' | 'playing';

/**
 * What the user set; the engine derives `tt` from it on every animation frame (plan D75):
 * live -> wall clock, paused -> `ttAnchor`, playing -> `ttAnchor + speed * elapsed`.
 */
export interface ClockControl {
  mode: ClockMode;
  /** Signed simulated seconds per real second (0 while paused or live). */
  speed: number;
  ttAnchor: number;
  /** `Date.now()` when `ttAnchor` was set. */
  wallAnchorMs: number;
}

export interface ClockState extends ClockControl {
  /** Mirror of the engine's `tt`, published at most twice per second (URL and UI). */
  tt: number;
  /** TT - UTC (or TT - UT1 before 1972) in seconds, from `/meta` then from each frame window. */
  ttMinusUtc: number;
}

/** View direction and vertical field of view, degrees. */
export interface ViewState {
  az: number;
  alt: number;
  fov: number;
}

export const LAYER_IDS = [
  'stars',
  'planets',
  'dso',
  'minor',
  'clines',
  'cnames',
  'cbounds',
  'azgrid',
  'eqgrid',
  'ecliptic',
  'meridian',
  'horizon',
] as const;
export type LayerId = (typeof LAYER_IDS)[number];
export type LayerFlags = Readonly<Record<LayerId, boolean>>;

export const DSO_TYPES = [
  'galaxy',
  'open_cluster',
  'globular_cluster',
  'planetary_nebula',
  'nebula',
  'other',
] as const;
export type DsoType = (typeof DSO_TYPES)[number];

export type Ground = 'opaque' | 'dim' | 'off';
export type LabelDensity = 0 | 1 | 2 | 3;
export type Lang = 'en' | 'fr';

export interface Options {
  ground: Ground;
  atm: boolean;
  refr: boolean;
  /** Manual magnitude limit; `null` follows the field of view (SKY-1). */
  maglim: number | null;
  labels: LabelDensity;
  night: boolean;
  lang: Lang;
}

/**
 * The complete UX-2 view state as carried by the URL (plan D79). Every field is optional: an
 * absent or invalid parameter is simply missing and the store keeps its default.
 */
export interface UrlState {
  body?: string;
  lat?: number;
  lon?: number;
  elev?: number;
  /** `'live'` or a TT Julian Date. */
  t?: 'live' | number;
  speed?: number;
  az?: number;
  alt?: number;
  fov?: number;
  layers?: readonly LayerId[];
  ground?: Ground;
  atm?: boolean;
  refr?: boolean;
  maglim?: number;
  dso?: readonly DsoType[];
  minor?: readonly string[];
  labels?: LabelDensity;
  lang?: Lang;
  night?: boolean;
  sel?: string;
}

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'missing' | 'stale' | 'error';
export type BootPhase = 'health' | 'meta' | 'catalogs' | 'frame' | 'ready' | 'error';

export interface DownloadProgress {
  file: string;
  downloadedBytes: number;
  totalBytes: number;
}

export type BootError =
  | { kind: 'unreachable' }
  | { kind: 'http'; status: number }
  | { kind: 'fatal'; detail: string }
  | { kind: 'webgl2' };

export interface BootState {
  phase: BootPhase;
  attempt: number;
  retryAtMs: number | null;
  progress: DownloadProgress | null;
  error: BootError | null;
}

export type CatalogName = 'stars' | 'index' | 'dso' | 'constellations';
export type CatalogsStatus = Readonly<Record<CatalogName, LoadStatus>>;

export interface FrameWindowInfo {
  tt0: number;
  stepS: number;
  n: number;
  bodies: readonly string[];
}

/** A warning of the closed contract list (brief l.168), kept for the M4 badges. */
export interface SkyWarning {
  code: string;
  params?: Readonly<Record<string, number | string>>;
  rangeTt?: readonly [number, number];
}

export interface FramesState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  window: FrameWindowInfo | null;
  snapshot: boolean;
  extrapolating: boolean;
  warnings: readonly SkyWarning[];
  /**
   * The last failed frame request while no window was loaded; `blocked` means the controller
   * will not retry that request (422 outside coverage, another 4xx, a long 503), so the boot
   * stops waiting for a first frame (plan D87). Cleared by the next successful window.
   */
  lastError: { status: number; blocked: boolean } | null;
}

export interface EngineState {
  kind: Backend | null;
  status: 'idle' | 'creating' | 'running' | 'failed';
}

/** The SKYS columns as zero-copy typed-array views (docs/api.md "SKYS v1"). */
export interface StarColumns {
  count: number;
  epochTt: number;
  /** ICRF unit vectors, `3 * count`. */
  dir: Float32Array;
  /** Proper-motion velocity in radians per Julian year, `3 * count`. */
  pm: Float32Array;
  /** Johnson V in millimagnitudes. */
  mag: Int16Array;
  /** B-V in millimagnitudes, 32767 when unknown. */
  bv: Int16Array;
  hip: Uint32Array;
}

/** Sentinel of an unknown B-V in the SKYS `bv` column. */
export const BV_UNKNOWN = 32767;

/**
 * Everything the engine needs for one animation frame, evaluated at `tt` from the current frame
 * window (plan D74): body directions are apparent ICRF unit vectors laid out body-major
 * (`dir[3 i .. 3 i + 2]` for `bodyIds[i]`), scalar channels are `NaN` when unknown.
 */
export interface FrameEval {
  /** `false` until the first window has arrived. */
  valid: boolean;
  /** `tt` lies outside the loaded window and the values are extrapolated (brief l.69). */
  extrapolating: boolean;
  /** The window is a single sample (snapshot mode, brief l.70). */
  snapshot: boolean;
  tt: number;
  ttMinusUtc: number;
  /** ICRF -> ENU. */
  horizonQ: Quat;
  /** ICRF -> true equator and equinox of date. */
  equinoxQ: Quat;
  /** Observer -> Sun, ICRF unit vector. */
  sunDir: Vec3;
  /** Barycentric velocity of the observer, au/day, ICRF. */
  observerVelocity: Vec3;
  /** Local apparent sidereal time in hours, `NaN` off Earth. */
  lstHours: number;
  bodyCount: number;
  bodyIds: string[];
  bodyKinds: string[];
  dir: Float64Array;
  distAu: Float64Array;
  mag: Float64Array;
  phase: Float64Array;
  diamDeg: Float64Array;
}

/** Preallocate a `FrameEval` able to hold `capacity` bodies. */
export function createFrameEval(capacity: number): FrameEval {
  return {
    valid: false,
    extrapolating: false,
    snapshot: false,
    tt: NaN,
    ttMinusUtc: NaN,
    horizonQ: [0, 0, 0, 1],
    equinoxQ: [0, 0, 0, 1],
    sunDir: [1, 0, 0],
    observerVelocity: [0, 0, 0],
    lstHours: NaN,
    bodyCount: 0,
    bodyIds: [],
    bodyKinds: [],
    dir: new Float64Array(3 * capacity),
    distAu: new Float64Array(capacity),
    mag: new Float64Array(capacity),
    phase: new Float64Array(capacity),
    diamDeg: new Float64Array(capacity),
  };
}

// Shared state types (plan D80). This is a leaf module: it imports only the pure tuple types,
// so `debug/skyDebugApi.ts` and the Playwright specs (type-checked by tsconfig.node.json) can
// reach it without dragging the store, the API schema or Babylon along. It stays import-free
// (values included): tsconfig.node.json resolves under `nodenext`, where the extensionless
// imports of `sky/math/*` do not resolve, so even a constant is restated here rather than imported.

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
  /** Mirror of the rendered local apparent sidereal time in hours, `NaN` off Earth or unknown. */
  lstHours: number;
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
/**
 * The supported languages (UX-1): the URL codec, the browser detection, the toggle and the
 * i18next `supportedLngs` all read this list; `i18n/index.ts` registers one resource file per
 * entry (a missing one fails to compile), so a new language touches `Lang`, this list and that
 * map, plus its JSON file (backlog B-72).
 */
export const LANGS: readonly Lang[] = ['en', 'fr'];

export interface Options {
  ground: Ground;
  atm: boolean;
  refr: boolean;
  /** Manual magnitude limit; `null` follows the field of view (SKY-1). */
  maglim: number | null;
  labels: LabelDensity;
  night: boolean;
  /** Night-mode brightness in `[0.3, 1]` (plan D108); only meaningful while `night` is on. */
  nightLevel: number;
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
  /** The decimal form of `night` (`night=0.6`): present only with `night: true` (plan D108). */
  nightLevel?: number;
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
  /** Incremented by `retryNow`: the boot's sleep and the frame controller's backoff end early. */
  retrySeq: number;
}

export type CatalogName = 'stars' | 'index' | 'dso' | 'constellations';
export type CatalogsStatus = Readonly<Record<CatalogName, LoadStatus>>;

export interface FrameWindowInfo {
  tt0: number;
  stepS: number;
  n: number;
  bodies: readonly string[];
}

/**
 * The closed list of warning codes (brief l.168). Hand-written so this leaf stays import-free;
 * `state/frames.ts` asserts at type level that it equals the contract's `WarningModel.code`.
 */
export type WarningCode =
  | 'iau_rotation_approximate'
  | 'pluto_barycenter'
  | 'delta_t_approximate'
  | 'proper_motion_extrapolated'
  | 'mpc_extrapolation'
  | 'mpc_unreliable';

/** A warning of the closed contract list (brief l.168), kept for the M4 badges. */
export interface SkyWarning {
  code: WarningCode;
  params?: Readonly<Record<string, number | string>>;
  rangeTt?: readonly [number, number];
}

/** One requested minor body of the current frame window (SKY-4, plan D102). */
export interface MinorStatus {
  id: string;
  name?: string;
  kind: string;
  elementsEpochTt: number;
  extrapolationYears: number;
  warnings: readonly SkyWarning[];
  /** `false` when the API sent `samples: null` (`mpc_unreliable`): nothing is rendered for it. */
  drawn: boolean;
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
  /**
   * A transient frame failure being retried (network, 429, 5xx), whatever the loaded window:
   * `status` of the last failed attempt (0 for a network error), `attempts` consecutive failed
   * attempts of the request shape (the client's own retries included, from the first one: plan
   * R70), the next attempt not before `nextRetryMs`. Cleared by the next successful response
   * (UX-6 banner, plan D92; mirrored by the debug hook as `state().failing`).
   */
  failing: { status: number; attempts: number; nextRetryMs: number } | null;
  /** The clock was stopped at a coverage bound (TIME-4); cleared by the next user time change. */
  coverageStop: { rangeTt: readonly [number, number] } | null;
  /** The minor bodies of the current window (plan D102), rebuilt when the window changes. */
  minor: readonly MinorStatus[];
}

export interface EngineState {
  kind: Backend | null;
  status: 'idle' | 'creating' | 'running' | 'failed';
}

/** Geolocation (OBS-1): `prompting` while the permission dialog is up, the outcome afterwards. */
export type GeoStatus =
  | 'idle'
  | 'unsupported'
  | 'insecure'
  | 'prompting'
  | 'granted'
  | 'denied'
  | 'unavailable'
  | 'timeout';

export interface GeoState {
  status: GeoStatus;
}

/** Why the last geocoder query produced nothing (OBS-4). */
export type GeocoderError = 'blocked' | 'unavailable' | 'invalid' | 'no_results';

export interface GeocoderResult {
  placeId: number;
  displayName: string;
  lat: number;
  lon: number;
  category: string;
  type: string;
}

export interface GeocoderState {
  /** `/meta.geocoder.enabled`, `true` until `/meta` says otherwise. */
  enabled: boolean;
  busy: boolean;
  /** Wall time of the last request, `-Infinity` before the first (>= 1 s apart, OBS-4). */
  lastRequestMs: number;
  results: readonly GeocoderResult[];
  error: GeocoderError | null;
}

export type PanelId = 'observer' | 'time' | 'layers' | 'details';
export type DialogId = 'about' | 'timeEditor';
export type StepUnit = 'minute' | 'hour' | 'day' | 'siderealDay' | 'year';
export type ToastKey =
  'share.copied' | 'share.failed' | 'export.failed' | 'details.unknown' | 'search.minorCapReached';

/** Session-only chrome state (plan D92): none of it is carried by the URL. */
export interface UiState {
  panel: PanelId | null;
  /** The mobile bottom sheet (VIEW-5). */
  sheet: 'collapsed' | 'expanded';
  dialog: DialogId | null;
  stepUnit: StepUnit;
  /**
   * The last running speed (1 for live), what Play and Space resume after a pause: recorded by
   * the store on every clock write that runs, so the button and the shortcut agree (TIME-3).
   */
  lastSpeed: number;
  /**
   * Single-key shortcuts enabled: the user's own switch (WCAG 2.2 SC 2.1.4); the listener itself
   * skips interactive targets and open dialogs regardless.
   */
  shortcuts: boolean;
  hintDismissed: boolean;
  /** `seq` increases with every toast so an identical key shows again. */
  toast: { seq: number; key: ToastKey } | null;
}

export type LabelKind =
  'selected' | 'cardinal' | 'body' | 'star' | 'dso' | 'constellation' | 'minor';

/** A label the engine currently draws (published at <= 1 Hz for the debug hook and tests). */
export interface VisibleLabel {
  id: string;
  kind: LabelKind;
  text: string;
}

/**
 * The engine's readout of the selected object (plan D93), published at <= 2 Hz: apparent
 * horizontal coordinates (`alt` refracted when refraction applies, `altTrue` geometric),
 * equatorial coordinates in ICRS and of date, and the body channels. `NaN` = unknown.
 */
export interface SelectionReadout {
  id: string;
  tt: number;
  /** `false` until the engine has found the object. */
  valid: boolean;
  alt: number;
  altTrue: number;
  az: number;
  raIcrs: number;
  decIcrs: number;
  raDate: number;
  decDate: number;
  distAu: number;
  mag: number;
  phase: number;
  diamDeg: number;
}

/** An empty readout: every channel unknown, `valid` false, no id. */
export function createSelectionReadout(): SelectionReadout {
  return {
    id: '',
    tt: NaN,
    valid: false,
    alt: NaN,
    altTrue: NaN,
    az: NaN,
    raIcrs: NaN,
    decIcrs: NaN,
    raDate: NaN,
    decDate: NaN,
    distAu: NaN,
    mag: NaN,
    phase: NaN,
    diamDeg: NaN,
  };
}

/** A request to centre the view on an object; `seq` tells a fresh request from a served one. */
export interface CentreRequest {
  id: string;
  seq: number;
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
  /**
   * The minor bodies of the window (plan D102), laid out like the bodies: `minorDir[3 m ..]` for
   * `minorIds[m]`; `minorDrawn[m]` is 0 when the API sent no samples (channels left `NaN`).
   */
  minorCount: number;
  minorIds: string[];
  minorKinds: string[];
  minorDir: Float64Array;
  minorDistAu: Float64Array;
  minorMag: Float64Array;
  minorPhase: Float64Array;
  minorDiamDeg: Float64Array;
  minorDrawn: Uint8Array;
}

/** Preallocate a `FrameEval` able to hold `capacity` bodies and `minorCapacity` minor bodies. */
export function createFrameEval(capacity: number, minorCapacity = 0): FrameEval {
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
    minorCount: 0,
    minorIds: [],
    minorKinds: [],
    minorDir: new Float64Array(3 * minorCapacity),
    minorDistAu: new Float64Array(minorCapacity),
    minorMag: new Float64Array(minorCapacity),
    minorPhase: new Float64Array(minorCapacity),
    minorDiamDeg: new Float64Array(minorCapacity),
    minorDrawn: new Uint8Array(minorCapacity),
  };
}

// ---------------------------------------------------------------------------------------------
// Augmented reality (AR-1..AR-5, brief l.237-241; plan D115): one session-only `ar` slice, never
// serialized (backlog B-73): the URL parameter set of UX-2 is closed, a gesture-gated permission
// cannot self-restore from a link, and a link opening a camera prompt on another phone would be a
// privacy surprise. `view.az/alt/fov` keep flowing to the URL while AR runs.

/**
 * `off` outside AR; `requesting` between the tap and the first pose (permission, camera and
 * sensors starting); `sensor` is the camera-plus-orientation mode (AR-1, AR-2); `xr` the WebXR
 * session (AR-4 [S]). Only the AR controller and the engine move it past `requesting`.
 */
export type ArMode = 'off' | 'requesting' | 'sensor' | 'xr';

/**
 * Outcome of `DeviceOrientationEvent.requestPermission()` run synchronously inside the tap
 * (plan D126): `pending` while the promise is open, `notRequired` when the static is absent
 * (Firefox Android), `prompt` when the browser answered so (Chromium >= 152) and the events decide.
 */
export type ArPermission = 'idle' | 'pending' | 'granted' | 'denied' | 'prompt' | 'notRequired';

/**
 * Where the heading comes from (AR-2, plan D118): `absolute` events (Android), the iOS
 * `webkitCompassHeading` (`compass`), relative events aligned by the user's drag (`relative`,
 * AR-3), or nothing yet. Both platforms give magnetic north (backlog B-74).
 */
export type HeadingSource = 'absolute' | 'compass' | 'relative' | 'none';

/**
 * The compass-accuracy indicator (AR-2): `good` for an absolute source or a compass within 15
 * degrees, `fair` up to 35, `poor` beyond, `invalid` for a negative iOS accuracy (calibrate),
 * `manual` for the relative source, `none` before the first sample. Computed by the controller
 * (`ui/**` may not import `sky/math`).
 */
export type CompassLevel = 'good' | 'fair' | 'poor' | 'invalid' | 'manual' | 'none';

/**
 * Why AR stopped or could not start (AR-5): rendered by `ui/components/Banners.tsx` through
 * `ar.error.<code>`, cleared by `clearArError`. The `xr*` codes leave the session but keep the
 * sensor mode (plan D128).
 */
export type ArError =
  | 'noCamera'
  | 'noRearCamera'
  | 'cameraDenied'
  | 'cameraUnavailable'
  | 'trackEnded'
  | 'orientationDenied'
  | 'orientationUnavailable'
  | 'xrUnsupported'
  | 'xrDenied'
  | 'xrBusy'
  | 'xrFailed';

/**
 * The AR-1 gate (plan D125): secure context, `navigator.mediaDevices` present (the literal
 * `getUserMedia` is reserved to the lazy camera chunk, D131), `DeviceOrientationEvent`, a touch or
 * coarse pointer, and a `videoinput` device. The button renders only when every flag holds and the
 * observer stands on Earth; the rear facing is verified at entry (backlog B-76).
 */
export interface ArCapabilities {
  secure: boolean;
  camera: boolean;
  orientation: boolean;
  touch: boolean;
  videoInput: boolean;
}

/** `navigator.xr.isSessionSupported('immersive-ar')` on the WebGL2 backend (plan D129). */
export type XrSupport = 'unknown' | 'unsupported' | 'supported';

export type XrPhase = 'idle' | 'entering' | 'active' | 'exiting';

/** The WebXR sub-state (AR-4): `aligned` says whether the session's north came from a heading. */
export interface ArXrState {
  support: XrSupport;
  phase: XrPhase;
  /** `null` outside a session; `false` when the user must align north by hand (plan D130). */
  aligned: boolean | null;
}

/** The heading source and its quality, written by the controller on change only (AR-2). */
export interface ArHeading {
  source: HeadingSource;
  /** Raw `webkitCompassAccuracy` in degrees, `null` when the platform gives none; negative = invalid. */
  accuracyDeg: number | null;
  level: CompassLevel;
}

/** Intrinsic size of the camera video (`videoWidth` x `videoHeight`), for the field model. */
export interface ArFrameSize {
  width: number;
  height: number;
}

/** The session-only augmented-reality slice (plan D115). */
export interface ArState {
  mode: ArMode;
  /** `null` until `state/arCapabilities.ts` ran (main.tsx); re-run on `devicechange`. */
  capabilities: ArCapabilities | null;
  permission: ArPermission;
  /** The last failure (AR-5); survives `exitAr` and is cleared by `clearArError`. */
  error: ArError | null;
  heading: ArHeading;
  /** AR-3 calibration offset added to the sensor azimuth, degrees, wrapped to `[-180, 180)`. */
  azOffsetDeg: number;
  /** Assumed DIAGONAL field of the rear camera in degrees (AR-2, plan D123): default 73, [50, 110]. */
  cameraFovDeg: number;
  frame: ArFrameSize | null;
  /**
   * Camera roll about the view axis in degrees (plan D119): right-handed in ENU, positive when
   * the screen top leans to the user's right; 0 outside AR. The one per-frame field.
   */
  roll: number;
  /** The view at entry; its `fov` is restored on exit, the direction is kept (plan D115). */
  viewBefore: ViewState | null;
  /** The manual-north / calibration hint was dismissed (AR-3). */
  hintDismissed: boolean;
  xr: ArXrState;
}

/**
 * The slice as a fresh page load sees it: AR off, nothing probed, no error, the default diagonal
 * field of 73 degrees (the same literal as `sky/math/cameraFov.ts::DEFAULT_CAMERA_DIAGONAL_FOV_DEG`,
 * pinned equal by `cameraFov.test.ts`; see the module header for why it is not imported).
 */
export function createArState(): ArState {
  return {
    mode: 'off',
    capabilities: null,
    permission: 'idle',
    error: null,
    heading: { source: 'none', accuracyDeg: null, level: 'none' },
    azOffsetDeg: 0,
    cameraFovDeg: 73,
    frame: null,
    roll: 0,
    viewBefore: null,
    hintDismissed: false,
    xr: { support: 'unknown', phase: 'idle', aligned: null },
  };
}

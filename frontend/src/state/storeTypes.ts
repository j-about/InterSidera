// Shape of the simulation store (plan D80, D92): one zustand vanilla store shared by React
// (`useStore`) and the framework-agnostic engine (`subscribe` with selectors). Implemented by
// `state/store.ts`.

import type { CatalogBundle } from '../api/catalogs';
import type { ProblemSlug } from '../api/client';
import type { components } from '../api/schema';
import type {
  BootState,
  CatalogName,
  CatalogsStatus,
  CentreRequest,
  ClockState,
  DialogId,
  DsoType,
  EngineState,
  FramesState,
  GeoState,
  GeoStatus,
  GeocoderState,
  LayerFlags,
  LayerId,
  LoadStatus,
  Observer,
  Options,
  PanelId,
  SelectionReadout,
  ToastKey,
  UiState,
  UrlState,
  ViewState,
  VisibleLabel,
} from './types';

export type MetaResponse = components['schemas']['MetaResponse'];
export type HealthResponse = components['schemas']['HealthResponse'];
export type MinorBodySummary = components['schemas']['MinorBodySummary'];
export type AltAzEntry = components['schemas']['AltAzEntry'];

/** The `/sky/altaz` row of the selected object (INFO-2), fetched by the details controller. */
export interface DetailsState {
  /** The selection the entry belongs to (`null` = nothing requested). */
  id: string | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  entry: AltAzEntry | null;
  /** The instant the entry was computed for (`NaN` before the first answer). */
  tt: number;
  /** Whether `entry.alt_deg` is refracted. */
  refraction: boolean;
  /** IAU abbreviation of the constellation holding the selection, `null` when unknown. */
  con: string | null;
  error: { status: number; slug: ProblemSlug; rangeTt?: readonly [number, number] } | null;
}

/** `/minor-bodies/defaults` (SKY-4, plan D102): fetched when the layer first turns on. */
export interface MinorBodiesState {
  defaults: readonly MinorBodySummary[] | null;
  status: LoadStatus;
  /** How many of `defaults` are requested (20, "show more" -> all). */
  shown: number;
}

export interface SkyState {
  observer: Observer;
  clock: ClockState;
  view: ViewState;
  layers: LayerFlags;
  options: Options;
  /** DSO type filter of the URL (`dso`), `null` = every type (M4 rendering). */
  dsoTypes: readonly DsoType[] | null;
  /** Pinned minor-body ids of the URL (`minor`, M4 rendering). */
  minor: readonly string[];
  /** Selected object in the `/sky/altaz` target syntax (`sel`), M4. */
  selection: string | null;
  meta: MetaResponse | null;
  health: HealthResponse | null;
  boot: BootState;
  catalogs: CatalogsStatus;
  frames: FramesState;
  engine: EngineState;
  geo: GeoState;
  geocoder: GeocoderState;
  ui: UiState;
  /** The camera follows the selection (plan D93). */
  follow: boolean;
  labels: { visible: readonly VisibleLabel[] };
  /** The engine's readout of the selection, `null` while nothing is selected or found. */
  readout: SelectionReadout | null;
  details: DetailsState;
  minorBodies: MinorBodiesState;
  /** The loaded catalogs (`BootHandle.bundle()`), `null` until the boot has them. */
  bundle: CatalogBundle | null;
  centreRequest: CentreRequest | null;
  /** Stable object: components select `state.actions` without re-rendering on every change. */
  actions: SkyActions;
}

export interface SkyActions {
  setObserver(observer: Observer): void;
  setView(view: Partial<ViewState>): void;
  setLayer(id: LayerId, on: boolean): void;
  setOptions(patch: Partial<Options>): void;
  setDsoTypes(types: readonly DsoType[] | null): void;
  setMinor(ids: readonly string[]): void;
  /** Select an object; deselecting (`null`) also stops following it. */
  select(id: string | null): void;
  /** Pause at the current simulation time (`nowMs` defaults to `Date.now()`). */
  pause(nowMs?: number): void;
  /** Play from the current simulation time at a signed speed. */
  play(speed: number, nowMs?: number): void;
  live(nowMs?: number): void;
  /** Pause at an explicit TT Julian Date. */
  setTime(tt: number, nowMs?: number): void;
  /**
   * Stop the clock one guard inside a coverage bound (TIME-4): paused at
   * `clampInsideCoverage(ttAt(now), rangeTt)` with `frames.coverageStop` set.
   */
  stopAtBound(rangeTt: readonly [number, number], nowMs?: number): void;
  /**
   * Shift the simulation time by `delta` seconds, or by one calendar year (same UTC date, Feb 29
   * falling back to Feb 28). The mode is kept: paused stays paused, playing keeps its speed,
   * live becomes playing at 1x from the new time.
   */
  stepTime(delta: number | { years: 1 | -1 }, nowMs?: number): void;
  /** Engine only: the mirror of the rendered `tt` and sidereal time, at most twice per second. */
  publishTt(tt: number, lstHours: number): void;
  /** Engine only: the readout of the selection, at most twice per second. */
  publishReadout(readout: SelectionReadout | null): void;
  /** Engine only: the labels drawn, at most once per second and only on change. */
  setVisibleLabels(list: readonly VisibleLabel[]): void;
  setTtMinusUtc(seconds: number): void;
  setMeta(meta: MetaResponse): void;
  setHealth(health: HealthResponse | null): void;
  setBoot(patch: Partial<BootState>): void;
  setCatalogStatus(name: CatalogName, status: LoadStatus): void;
  setFrames(patch: Partial<FramesState>): void;
  setEngine(patch: Partial<EngineState>): void;
  setGeo(status: GeoStatus): void;
  setGeocoder(patch: Partial<GeocoderState>): void;
  setUi(patch: Partial<UiState>): void;
  /** Open a panel; on the phone this also expands the sheet. */
  openPanel(id: PanelId): void;
  closePanel(): void;
  openDialog(id: DialogId): void;
  closeDialog(): void;
  showToast(key: ToastKey): void;
  dismissHint(): void;
  /** Night-mode brightness, clamped to `[0.3, 1]`. */
  setNightLevel(level: number): void;
  setFollow(on: boolean): void;
  /** Pin a minor body; `false` when the cap (`limits.max_minor_bodies`) refuses it. */
  pinMinor(id: string): boolean;
  unpinMinor(id: string): void;
  setMinorDefaults(list: readonly MinorBodySummary[] | null, status: LoadStatus): void;
  /** Request every default minor body instead of the first twenty. */
  showMoreMinor(): void;
  setDetails(patch: Partial<DetailsState>): void;
  setBundle(bundle: CatalogBundle | null): void;
  /** Ask the engine to centre the view on an object (served once, then cleared). */
  requestCentre(id: string): void;
  /** Engine only: the request with this `seq` was served. */
  clearCentre(seq: number): void;
  /** Retry the boot or the frame request now instead of waiting for the backoff. */
  retryNow(): void;
  /** Apply a parsed URL (initial load, `popstate`); absent fields keep their current values. */
  applyUrl(url: UrlState, nowMs?: number): void;
}

/** The store API both React and the engine use (zustand vanilla + `subscribeWithSelector`). */
export interface SkyStore {
  getState(): SkyState;
  getInitialState(): SkyState;
  setState(
    partial: SkyState | Partial<SkyState> | ((state: SkyState) => SkyState | Partial<SkyState>),
    replace?: false,
  ): void;
  subscribe(listener: (state: SkyState, previous: SkyState) => void): () => void;
  subscribe<U>(
    selector: (state: SkyState) => U,
    listener: (value: U, previous: U) => void,
    options?: { equalityFn?: (a: U, b: U) => boolean; fireImmediately?: boolean },
  ): () => void;
}

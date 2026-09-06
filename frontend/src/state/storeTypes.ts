// Shape of the simulation store (plan D80): one zustand vanilla store shared by React (`useStore`)
// and the framework-agnostic engine (`subscribe` with selectors). Implemented by `state/store.ts`.

import type { components } from '../api/schema';
import type {
  BootState,
  CatalogName,
  CatalogsStatus,
  ClockState,
  DsoType,
  EngineState,
  FramesState,
  LayerFlags,
  LayerId,
  LoadStatus,
  Observer,
  Options,
  UrlState,
  ViewState,
} from './types';

export type MetaResponse = components['schemas']['MetaResponse'];
export type HealthResponse = components['schemas']['HealthResponse'];

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
  select(id: string | null): void;
  /** Pause at the current simulation time (`nowMs` defaults to `Date.now()`). */
  pause(nowMs?: number): void;
  /** Play from the current simulation time at a signed speed. */
  play(speed: number, nowMs?: number): void;
  live(nowMs?: number): void;
  /** Pause at an explicit TT Julian Date. */
  setTime(tt: number, nowMs?: number): void;
  /** Engine only: the mirror of the rendered `tt`, at most twice per second. */
  publishTt(tt: number): void;
  setTtMinusUtc(seconds: number): void;
  setMeta(meta: MetaResponse): void;
  setHealth(health: HealthResponse | null): void;
  setBoot(patch: Partial<BootState>): void;
  setCatalogStatus(name: CatalogName, status: LoadStatus): void;
  setFrames(patch: Partial<FramesState>): void;
  setEngine(patch: Partial<EngineState>): void;
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

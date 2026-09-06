// The single simulation store (plan D80, brief l.85): a zustand vanilla store with
// `subscribeWithSelector`, shared by React (`useStore`) and the framework-agnostic engine
// (selector subscriptions). The engine owns time: it derives `tt` from `clock`'s control block on
// every frame and publishes the mirror through `publishTt` at most twice per second; the store
// itself never ticks. Every per-user value here round-trips through the URL (OBS-8).

import { subscribeWithSelector } from 'zustand/middleware';
import { createStore } from 'zustand/vanilla';

import { clampCameraAltDeg, clampFovDeg, wrapAzimuthDeg } from '../sky/math/frames';
import { anchored, liveControl, pausedAt, ttAt } from './clock';
import type { SkyActions, SkyState, SkyStore } from './storeTypes';
import { LAYER_IDS } from './types';
import type {
  ClockControl,
  ClockState,
  LayerFlags,
  LayerId,
  Observer,
  Options,
  UrlState,
  ViewState,
} from './types';

/** Default observer when the URL names none (OBS-2, brief l.191; geolocation arrives at M4). */
export const GREENWICH: Observer = { body: 'earth', lat: 51.48, lon: 0, elev: 0 };

/** Layers on by default at M3 (plan Q30): `dso` and `clines` join the defaults at M4. */
export const DEFAULT_LAYERS: LayerFlags = {
  stars: true,
  planets: true,
  dso: false,
  minor: false,
  clines: false,
  cnames: false,
  cbounds: false,
  azgrid: false,
  eqgrid: false,
  ecliptic: false,
  meridian: false,
  horizon: true,
};

export const DEFAULT_OPTIONS: Options = {
  ground: 'dim',
  atm: true,
  refr: true,
  maglim: null,
  labels: 2,
  night: false,
  lang: 'en',
};

/** Looking north, 20 degrees up, with a 60 degree vertical field of view. */
export const DEFAULT_VIEW: ViewState = { az: 0, alt: 20, fov: 60 };

/**
 * TT - UTC before `/meta` answers: 32.184 s + 37 leap seconds, valid since 2017 (brief l.51:
 * the value is replaced by `/meta.server_time.tt_minus_utc_seconds`, then by each frame window).
 */
export const TT_MINUS_UTC_SEED_S = 69.184;

/** The URL semantics of `t` and `speed` (plan D79) as a control block anchored at `nowMs`. */
function controlFromUrl(url: UrlState, nowMs: number): ClockControl | null {
  if (url.t === undefined) {
    return null;
  }
  if (url.t === 'live') {
    return liveControl(nowMs);
  }
  const speed = url.speed ?? 0;
  if (speed === 0) {
    return pausedAt(url.t, nowMs);
  }
  return { mode: 'playing', speed, ttAnchor: url.t, wallAnchorMs: nowMs };
}

function clockFrom(control: ClockControl, nowMs: number, ttMinusUtc: number): ClockState {
  return { ...control, tt: ttAt(control, nowMs, ttMinusUtc), ttMinusUtc };
}

function layersFromList(list: readonly LayerId[]): LayerFlags {
  const flags: Record<LayerId, boolean> = { ...DEFAULT_LAYERS };
  for (const id of LAYER_IDS) {
    flags[id] = list.includes(id);
  }
  return flags;
}

/** The URL keys that feed `options`; `applyUrl` leaves `options` untouched when none is present. */
const OPTION_KEYS: readonly (keyof Options & keyof UrlState)[] = [
  'ground',
  'atm',
  'refr',
  'maglim',
  'labels',
  'night',
  'lang',
];

function optionsFromUrl(url: UrlState, base: Options): Options {
  return {
    ground: url.ground ?? base.ground,
    atm: url.atm ?? base.atm,
    refr: url.refr ?? base.refr,
    maglim: url.maglim ?? base.maglim,
    labels: url.labels ?? base.labels,
    night: url.night ?? base.night,
    lang: url.lang ?? base.lang,
  };
}

function canonicalView(view: ViewState): ViewState {
  return {
    az: wrapAzimuthDeg(view.az),
    alt: clampCameraAltDeg(view.alt),
    fov: clampFovDeg(view.fov),
  };
}

/** The store as a fresh page load sees it: URL values over the defaults (plan D87). */
export function createSkyStore(initial: UrlState = {}, nowMs: number = Date.now()): SkyStore {
  const observer: Observer = {
    body: initial.body ?? GREENWICH.body,
    lat: initial.lat ?? GREENWICH.lat,
    lon: initial.lon ?? GREENWICH.lon,
    elev: initial.elev ?? GREENWICH.elev,
  };
  const clock = clockFrom(
    controlFromUrl(initial, nowMs) ?? liveControl(nowMs),
    nowMs,
    TT_MINUS_UTC_SEED_S,
  );
  const view = canonicalView({
    az: initial.az ?? DEFAULT_VIEW.az,
    alt: initial.alt ?? DEFAULT_VIEW.alt,
    fov: initial.fov ?? DEFAULT_VIEW.fov,
  });

  const store = createStore<SkyState>()(
    subscribeWithSelector((set, get) => {
      const setClock = (control: ClockControl, nowMs: number): void => {
        const { ttMinusUtc } = get().clock;
        set({ clock: clockFrom(control, nowMs, ttMinusUtc) });
      };

      const actions: SkyActions = {
        setObserver(next) {
          set({ observer: next });
        },
        setView(patch) {
          set({ view: canonicalView({ ...get().view, ...patch }) });
        },
        setLayer(id, on) {
          set({ layers: { ...get().layers, [id]: on } });
        },
        setOptions(patch) {
          set({ options: { ...get().options, ...patch } });
        },
        setDsoTypes(types) {
          set({ dsoTypes: types });
        },
        setMinor(ids) {
          set({ minor: ids });
        },
        select(id) {
          set({ selection: id });
        },
        pause(nowMs = Date.now()) {
          const { clock } = get();
          setClock(anchored(clock, nowMs, clock.ttMinusUtc, { mode: 'paused', speed: 0 }), nowMs);
        },
        play(speed, nowMs = Date.now()) {
          const { clock } = get();
          // Playing at speed 0 is a pause: the control block says so instead of pretending.
          const patch: Partial<Pick<ClockControl, 'mode' | 'speed'>> =
            speed === 0 ? { mode: 'paused', speed: 0 } : { mode: 'playing', speed };
          setClock(anchored(clock, nowMs, clock.ttMinusUtc, patch), nowMs);
        },
        live(nowMs = Date.now()) {
          setClock(liveControl(nowMs), nowMs);
        },
        setTime(tt, nowMs = Date.now()) {
          setClock(pausedAt(tt, nowMs), nowMs);
        },
        publishTt(tt) {
          const { clock } = get();
          // Written NaN-safe: a NaN mirror must be replaced by the first real value.
          if (!(Math.abs(tt - clock.tt) <= 1e-6)) {
            set({ clock: { ...clock, tt } });
          }
        },
        setTtMinusUtc(seconds) {
          set({ clock: { ...get().clock, ttMinusUtc: seconds } });
        },
        setMeta(meta) {
          set({ meta });
        },
        setHealth(health) {
          set({ health });
        },
        setBoot(patch) {
          set({ boot: { ...get().boot, ...patch } });
        },
        setCatalogStatus(name, status) {
          set({ catalogs: { ...get().catalogs, [name]: status } });
        },
        setFrames(patch) {
          set({ frames: { ...get().frames, ...patch } });
        },
        setEngine(patch) {
          set({ engine: { ...get().engine, ...patch } });
        },
        applyUrl(url, nowMs = Date.now()) {
          const state = get();
          const patch: Partial<SkyState> = {};
          if (
            url.body !== undefined ||
            url.lat !== undefined ||
            url.lon !== undefined ||
            url.elev !== undefined
          ) {
            patch.observer = {
              body: url.body ?? state.observer.body,
              lat: url.lat ?? state.observer.lat,
              lon: url.lon ?? state.observer.lon,
              elev: url.elev ?? state.observer.elev,
            };
          }
          // `speed` without `t` is not a complete clock statement and is ignored (plan D79).
          const control = controlFromUrl(url, nowMs);
          if (control !== null) {
            patch.clock = clockFrom(control, nowMs, state.clock.ttMinusUtc);
          }
          if (url.az !== undefined || url.alt !== undefined || url.fov !== undefined) {
            patch.view = canonicalView({
              az: url.az ?? state.view.az,
              alt: url.alt ?? state.view.alt,
              fov: url.fov ?? state.view.fov,
            });
          }
          if (url.layers !== undefined) {
            patch.layers = layersFromList(url.layers);
          }
          // A fresh `options` object would wake every `options` subscriber (lang, night) on each
          // `popstate`: only build one when the URL actually carries an option.
          if (OPTION_KEYS.some((key) => url[key] !== undefined)) {
            patch.options = optionsFromUrl(url, state.options);
          }
          if (url.dso !== undefined) {
            patch.dsoTypes = url.dso;
          }
          if (url.minor !== undefined) {
            patch.minor = url.minor;
          }
          if (url.sel !== undefined) {
            patch.selection = url.sel;
          }
          set(patch);
        },
      };

      return {
        observer,
        clock,
        view,
        layers: initial.layers === undefined ? DEFAULT_LAYERS : layersFromList(initial.layers),
        options: optionsFromUrl(initial, DEFAULT_OPTIONS),
        dsoTypes: initial.dso ?? null,
        minor: initial.minor ?? [],
        selection: initial.sel ?? null,
        meta: null,
        health: null,
        boot: { phase: 'health', attempt: 0, retryAtMs: null, progress: null, error: null },
        catalogs: { stars: 'idle', index: 'idle', dso: 'idle', constellations: 'idle' },
        frames: {
          status: 'idle',
          window: null,
          snapshot: false,
          extrapolating: false,
          warnings: [],
          lastError: null,
        },
        engine: { kind: null, status: 'idle' },
        actions,
      };
    }),
  );
  return store;
}

/** The URL view of a state (plan D79): `t` is `live` in live mode, `speed` only while playing. */
export function urlStateOf(state: SkyState): UrlState {
  const url: UrlState = {
    body: state.observer.body,
    lat: state.observer.lat,
    lon: state.observer.lon,
    elev: state.observer.elev,
    t: state.clock.mode === 'live' ? 'live' : state.clock.tt,
    az: state.view.az,
    alt: state.view.alt,
    fov: state.view.fov,
    layers: LAYER_IDS.filter((id) => state.layers[id]),
    ground: state.options.ground,
    atm: state.options.atm,
    refr: state.options.refr,
    minor: state.minor,
    labels: state.options.labels,
    lang: state.options.lang,
    night: state.options.night,
  };
  if (state.clock.mode === 'playing') {
    url.speed = state.clock.speed;
  }
  if (state.options.maglim !== null) {
    url.maglim = state.options.maglim;
  }
  if (state.dsoTypes !== null) {
    url.dso = state.dsoTypes;
  }
  if (state.selection !== null) {
    url.sel = state.selection;
  }
  return url;
}

/** The defaults `serializeUrlState` omits (`maglim`, `dso`, `sel` and `speed` have none). */
export function defaultsUrlState(): UrlState {
  return {
    body: GREENWICH.body,
    lat: GREENWICH.lat,
    lon: GREENWICH.lon,
    elev: GREENWICH.elev,
    t: 'live',
    az: DEFAULT_VIEW.az,
    alt: DEFAULT_VIEW.alt,
    fov: DEFAULT_VIEW.fov,
    layers: LAYER_IDS.filter((id) => DEFAULT_LAYERS[id]),
    ground: DEFAULT_OPTIONS.ground,
    atm: DEFAULT_OPTIONS.atm,
    refr: DEFAULT_OPTIONS.refr,
    minor: [],
    labels: DEFAULT_OPTIONS.labels,
    lang: DEFAULT_OPTIONS.lang,
    night: DEFAULT_OPTIONS.night,
  };
}

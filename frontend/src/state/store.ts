// The single simulation store (plan D80, D92, brief l.85): a zustand vanilla store with
// `subscribeWithSelector`, shared by React (`useStore`) and the framework-agnostic engine
// (selector subscriptions). The engine owns time: it derives `tt` from `clock`'s control block on
// every frame and publishes the mirror through `publishTt` at most twice per second; the store
// itself never ticks. Every per-user value here round-trips through the URL (OBS-8); the `ui`,
// `geo`, `geocoder`, `details`, `readout`, `labels`, `minorBodies` and `ar` slices are
// session-only (the `ar` slice by decision, plan D115, backlog B-73).

import { subscribeWithSelector } from 'zustand/middleware';
import { createStore } from 'zustand/vanilla';

import { clampCameraDiagonalFovDeg } from '../sky/math/cameraFov';
import { clampCameraAltDeg, clampFovDeg, wrapAzimuthDeg, wrapSignedDeg } from '../sky/math/frames';
import { DAY_S } from '../sky/math/time';
import { anchored, liveControl, pausedAt, ttAt } from './clock';
import { clampInsideCoverage } from './frames';
import type { SkyActions, SkyState, SkyStore } from './storeTypes';
import { shiftYears } from './timeDisplay';
import { LAYER_IDS, createArState } from './types';
import type {
  ArError,
  ArState,
  ClockControl,
  ClockState,
  LayerFlags,
  LayerId,
  Observer,
  Options,
  UrlState,
  ViewState,
} from './types';

/** Default observer when the URL names none (OBS-2, brief l.191; geolocation replaces it). */
export const GREENWICH: Observer = { body: 'earth', lat: 51.48, lon: 0, elev: 0 };

/** Layers on by default (plan Q30): stars, planets, deep-sky objects, constellation lines, horizon. */
export const DEFAULT_LAYERS: LayerFlags = {
  stars: true,
  planets: true,
  dso: true,
  minor: false,
  clines: true,
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
  nightLevel: 1,
  lang: 'en',
};

/** Night-mode brightness range (plan D108). */
export const NIGHT_LEVEL_MIN = 0.3;
export const NIGHT_LEVEL_MAX = 1;

/** Looking north, 20 degrees up, with a 60 degree vertical field of view. */
export const DEFAULT_VIEW: ViewState = { az: 0, alt: 20, fov: 60 };

/**
 * TT - UTC before `/meta` answers: 32.184 s + 37 leap seconds, valid since 2017 (brief l.51:
 * the value is replaced by `/meta.server_time.tt_minus_utc_seconds`, then by each frame window).
 */
export const TT_MINUS_UTC_SEED_S = 69.184;

/** Default minor bodies requested before "show more" (plan D102). */
export const MINOR_DEFAULTS_SHOWN = 20;
/** The pin cap before `/meta` announces `limits.max_minor_bodies` (brief l.164). */
const MAX_MINOR_FALLBACK = 100;

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

function clockFrom(
  control: ClockControl,
  nowMs: number,
  ttMinusUtc: number,
  lstHours: number,
): ClockState {
  return { ...control, tt: ttAt(control, nowMs, ttMinusUtc), ttMinusUtc, lstHours };
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
  'nightLevel',
  'lang',
];

/**
 * `night=1` means night at full brightness and `night=0.6` night at that brightness (plan D108);
 * `night=0` and an absent `night` leave the brightness alone (it is not written while off).
 */
function nightLevelFromUrl(url: UrlState, base: Options): number {
  if (url.nightLevel !== undefined) {
    return url.nightLevel;
  }
  return url.night === true ? NIGHT_LEVEL_MAX : base.nightLevel;
}

function optionsFromUrl(url: UrlState, base: Options): Options {
  return {
    ground: url.ground ?? base.ground,
    atm: url.atm ?? base.atm,
    refr: url.refr ?? base.refr,
    maglim: url.maglim ?? base.maglim,
    labels: url.labels ?? base.labels,
    night: url.night ?? base.night,
    nightLevel: nightLevelFromUrl(url, base),
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

/** The `ArError` codes that end a WebXR session but keep the sensor mode (plan D128). */
const XR_ERRORS: ReadonlySet<ArError> = new Set<ArError>([
  'xrUnsupported',
  'xrDenied',
  'xrBusy',
  'xrFailed',
]);

/** The `ar` slice after leaving AR (plan D115): off, the per-frame fields reset, the error kept. */
function arExited(ar: ArState): ArState {
  return {
    ...ar,
    mode: 'off',
    heading: { source: 'none', accuracyDeg: null, level: 'none' },
    frame: null,
    roll: 0,
    viewBefore: null,
    xr: { ...ar.xr, phase: 'idle', aligned: null },
  };
}

/** The speed a control block runs at: 0 paused, 1 live, else the playing speed (TIME-3). */
function runningSpeed(control: ClockControl): number {
  switch (control.mode) {
    case 'live':
      return 1;
    case 'paused':
      return 0;
    case 'playing':
      return control.speed;
  }
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
    NaN,
  );
  const view = canonicalView({
    az: initial.az ?? DEFAULT_VIEW.az,
    alt: initial.alt ?? DEFAULT_VIEW.alt,
    fov: initial.fov ?? DEFAULT_VIEW.fov,
  });
  // Monotonic counters: a toast or a centre request is told from the previous one by its `seq`
  // even after the slot was cleared in between.
  let toastSeq = 0;
  let centreSeq = 0;

  const store = createStore<SkyState>()(
    subscribeWithSelector((set, get) => {
      /**
       * A user time change: the new control block, and the coverage stop lifted (TIME-4: the
       * banner goes as soon as the clock moves). One `set`, so subscribers see both at once.
       */
      const setClock = (control: ClockControl, nowMs: number): void => {
        const { clock, frames, ui } = get();
        const patch: Partial<SkyState> = {
          clock: clockFrom(control, nowMs, clock.ttMinusUtc, clock.lstHours),
        };
        if (frames.coverageStop !== null) {
          patch.frames = { ...frames, coverageStop: null };
        }
        // The one memory of the last running speed, so the Play button and Space resume alike.
        const running = runningSpeed(control);
        if (running !== 0 && running !== ui.lastSpeed) {
          patch.ui = { ...ui, lastSpeed: running };
        }
        set(patch);
      };

      /** The observer moved by the user: a pending geolocation prompt no longer applies. */
      const geoAfterObserverChange = (patch: Partial<SkyState>): void => {
        if (get().geo.status === 'prompting') {
          patch.geo = { status: 'idle' };
        }
      };

      /**
       * Leave AR inside a patch (plan D115): `exitAr`, `failAr` and an observer moving off Earth
       * (AR-1) share it, so the exit and its cause land in one `set`. The field of view returns
       * to what it was at entry and the direction is kept; `keepFov` (a URL carrying its own
       * `fov`) skips the restoration. Nothing happens while AR is off.
       */
      const exitArInto = (patch: Partial<SkyState>, state: SkyState, keepFov = false): void => {
        const { ar } = state;
        if (ar.mode === 'off') {
          return;
        }
        patch.ar = arExited(ar);
        if (ar.viewBefore !== null && !keepFov) {
          patch.view = { ...(patch.view ?? state.view), fov: ar.viewBefore.fov };
        }
      };

      const actions: SkyActions = {
        setObserver(next) {
          const state = get();
          const patch: Partial<SkyState> = { observer: next };
          geoAfterObserverChange(patch);
          if (next.body !== 'earth') {
            exitArInto(patch, state);
          }
          set(patch);
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
          const patch: Partial<SkyState> = { selection: id };
          if (id === null) {
            patch.follow = false;
          }
          set(patch);
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
        stopAtBound(rangeTt, nowMs = Date.now()) {
          const { clock, frames } = get();
          const tt = clampInsideCoverage(ttAt(clock, nowMs, clock.ttMinusUtc), rangeTt);
          set({
            clock: clockFrom(pausedAt(tt, nowMs), nowMs, clock.ttMinusUtc, clock.lstHours),
            frames: { ...frames, coverageStop: { rangeTt } },
          });
        },
        stepTime(delta, nowMs = Date.now()) {
          const { clock } = get();
          // From the time the engine renders now, never from the <= 2 Hz mirror.
          const base = ttAt(clock, nowMs, clock.ttMinusUtc);
          const tt =
            typeof delta === 'number'
              ? base + delta / DAY_S
              : shiftYears(base, delta.years, clock.ttMinusUtc);
          let control: ClockControl;
          switch (clock.mode) {
            case 'paused':
              control = pausedAt(tt, nowMs);
              break;
            case 'playing':
              control = { mode: 'playing', speed: clock.speed, ttAnchor: tt, wallAnchorMs: nowMs };
              break;
            case 'live':
              // A step away from the wall clock cannot stay live: it plays on at 1x from there.
              control = { mode: 'playing', speed: 1, ttAnchor: tt, wallAnchorMs: nowMs };
              break;
          }
          setClock(control, nowMs);
        },
        publishTt(tt, lstHours) {
          const { clock } = get();
          // Written NaN-safe: a NaN mirror must be replaced by the first real value, and the
          // sidereal time compares with `Object.is` so NaN -> NaN stays quiet.
          if (!(Math.abs(tt - clock.tt) <= 1e-6) || !Object.is(lstHours, clock.lstHours)) {
            set({ clock: { ...clock, tt, lstHours } });
          }
        },
        publishReadout(readout) {
          set({ readout });
        },
        setVisibleLabels(list) {
          set({ labels: { visible: list } });
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
        setGeo(status) {
          set({ geo: { status } });
        },
        setGeocoder(patch) {
          set({ geocoder: { ...get().geocoder, ...patch } });
        },
        setUi(patch) {
          set({ ui: { ...get().ui, ...patch } });
        },
        openPanel(id) {
          set({ ui: { ...get().ui, panel: id, sheet: 'expanded' } });
        },
        closePanel() {
          set({ ui: { ...get().ui, panel: null, sheet: 'collapsed' } });
        },
        openDialog(id) {
          set({ ui: { ...get().ui, dialog: id } });
        },
        closeDialog() {
          set({ ui: { ...get().ui, dialog: null } });
        },
        showToast(key) {
          toastSeq += 1;
          set({ ui: { ...get().ui, toast: { seq: toastSeq, key } } });
        },
        dismissHint() {
          set({ ui: { ...get().ui, hintDismissed: true } });
        },
        setNightLevel(level) {
          if (!Number.isFinite(level)) {
            return;
          }
          const nightLevel = Math.min(NIGHT_LEVEL_MAX, Math.max(NIGHT_LEVEL_MIN, level));
          set({ options: { ...get().options, nightLevel } });
        },
        setFollow(on) {
          set({ follow: on });
        },
        pinMinor(id) {
          const { minor, meta } = get();
          if (minor.includes(id)) {
            return true;
          }
          const cap = meta?.limits.max_minor_bodies ?? MAX_MINOR_FALLBACK;
          if (minor.length >= cap) {
            return false;
          }
          set({ minor: [...minor, id] });
          return true;
        },
        unpinMinor(id) {
          const { minor } = get();
          if (minor.includes(id)) {
            set({ minor: minor.filter((pinned) => pinned !== id) });
          }
        },
        setMinorDefaults(list, status) {
          set({ minorBodies: { ...get().minorBodies, defaults: list, status } });
        },
        showMoreMinor() {
          const { minorBodies } = get();
          if (minorBodies.defaults !== null) {
            set({ minorBodies: { ...minorBodies, shown: minorBodies.defaults.length } });
          }
        },
        setDetails(patch) {
          set({ details: { ...get().details, ...patch } });
        },
        setBundle(bundle) {
          set({ bundle });
        },
        requestCentre(id) {
          centreSeq += 1;
          set({ centreRequest: { id, seq: centreSeq } });
        },
        clearCentre(seq) {
          if (get().centreRequest?.seq === seq) {
            set({ centreRequest: null });
          }
        },
        retryNow() {
          const { boot } = get();
          set({ boot: { ...boot, retrySeq: boot.retrySeq + 1 } });
        },
        setArCapabilities(caps) {
          set({ ar: { ...get().ar, capabilities: caps } });
        },
        requestAr() {
          const state = get();
          // AR-1 is Earth only: the button is hidden off Earth (plan D125) and a stray call stays a
          // no-op, the counterpart of the exit `setObserver`/`applyUrl` perform when leaving Earth.
          if (state.ar.mode !== 'off' || state.observer.body !== 'earth') {
            return;
          }
          set({
            ar: { ...state.ar, mode: 'requesting', viewBefore: state.view, error: null },
            follow: false,
            ui: { ...state.ui, sheet: 'collapsed', dialog: null },
          });
        },
        setArPermission(permission) {
          set({ ar: { ...get().ar, permission } });
        },
        setArMode(mode) {
          const { ar } = get();
          const allowed =
            (ar.mode === 'requesting' && mode === 'sensor') ||
            (ar.mode === 'sensor' && mode === 'xr') ||
            (ar.mode === 'xr' && mode === 'sensor');
          if (allowed) {
            set({ ar: { ...ar, mode } });
          }
        },
        exitAr() {
          const patch: Partial<SkyState> = {};
          exitArInto(patch, get());
          if (patch.ar !== undefined) {
            set(patch);
          }
        },
        failAr(code) {
          const state = get();
          const { ar } = state;
          if (XR_ERRORS.has(code) && (ar.mode === 'sensor' || ar.mode === 'xr')) {
            set({
              ar: {
                ...ar,
                mode: 'sensor',
                error: code,
                xr: { ...ar.xr, phase: 'idle', aligned: null },
              },
            });
            return;
          }
          const patch: Partial<SkyState> = {};
          exitArInto(patch, state);
          patch.ar = { ...(patch.ar ?? ar), error: code };
          set(patch);
        },
        clearArError() {
          const { ar } = get();
          if (ar.error !== null) {
            set({ ar: { ...ar, error: null } });
          }
        },
        setArPose(azDeg, altDeg, rollDeg) {
          const state = get();
          if (state.ar.mode === 'off') {
            return;
          }
          set({
            view: canonicalView({ ...state.view, az: azDeg, alt: altDeg }),
            ar: { ...state.ar, roll: rollDeg },
          });
        },
        setArHeading(heading) {
          set({ ar: { ...get().ar, heading } });
        },
        setArOffset(deg) {
          if (!Number.isFinite(deg)) {
            return;
          }
          set({ ar: { ...get().ar, azOffsetDeg: wrapSignedDeg(deg) } });
        },
        nudgeArOffset(deltaDeg) {
          if (!Number.isFinite(deltaDeg)) {
            return;
          }
          const { ar } = get();
          set({ ar: { ...ar, azOffsetDeg: wrapSignedDeg(ar.azOffsetDeg + deltaDeg) } });
        },
        setArCameraFov(deg) {
          set({ ar: { ...get().ar, cameraFovDeg: clampCameraDiagonalFovDeg(deg) } });
        },
        setArFrame(frame) {
          set({ ar: { ...get().ar, frame } });
        },
        setArXr(patch) {
          const { ar } = get();
          set({ ar: { ...ar, xr: { ...ar.xr, ...patch } } });
        },
        dismissArHint() {
          set({ ar: { ...get().ar, hintDismissed: true } });
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
            geoAfterObserverChange(patch);
          }
          // `speed` without `t` is not a complete clock statement and is ignored (plan D79).
          const control = controlFromUrl(url, nowMs);
          if (control !== null) {
            patch.clock = clockFrom(control, nowMs, state.clock.ttMinusUtc, state.clock.lstHours);
            // A time carried by the URL (Back to an instant inside coverage) lifts the TIME-4
            // stop like every other user time change.
            if (state.frames.coverageStop !== null) {
              patch.frames = { ...state.frames, coverageStop: null };
            }
            const running = runningSpeed(control);
            if (running !== 0 && running !== state.ui.lastSpeed) {
              patch.ui = { ...state.ui, lastSpeed: running };
            }
          }
          if (url.az !== undefined || url.alt !== undefined || url.fov !== undefined) {
            patch.view = canonicalView({
              az: url.az ?? state.view.az,
              alt: url.alt ?? state.view.alt,
              fov: url.fov ?? state.view.fov,
            });
          }
          // AR-1 is Earth only: a link or Back to another body leaves AR in the same write; a
          // `fov` the URL carries wins over the one remembered at entry.
          if (patch.observer !== undefined && patch.observer.body !== 'earth') {
            exitArInto(patch, state, url.fov !== undefined);
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
        boot: {
          phase: 'health',
          attempt: 0,
          retryAtMs: null,
          progress: null,
          error: null,
          retrySeq: 0,
        },
        catalogs: { stars: 'idle', index: 'idle', dso: 'idle', constellations: 'idle' },
        frames: {
          status: 'idle',
          window: null,
          snapshot: false,
          extrapolating: false,
          warnings: [],
          lastError: null,
          failing: null,
          coverageStop: null,
          minor: [],
        },
        engine: { kind: null, status: 'idle' },
        geo: { status: 'idle' },
        geocoder: {
          enabled: true,
          busy: false,
          lastRequestMs: -Infinity,
          results: [],
          error: null,
        },
        ui: {
          panel: null,
          sheet: 'collapsed',
          dialog: null,
          stepUnit: 'hour',
          shortcuts: true,
          hintDismissed: false,
          toast: null,
          lastSpeed: runningSpeed(clock) === 0 ? 1 : runningSpeed(clock),
        },
        follow: false,
        ar: createArState(),
        labels: { visible: [] },
        readout: null,
        details: {
          id: null,
          status: 'idle',
          entry: null,
          tt: NaN,
          refraction: false,
          con: null,
          error: null,
        },
        minorBodies: { defaults: null, status: 'idle', shown: MINOR_DEFAULTS_SHOWN },
        bundle: null,
        centreRequest: null,
        actions,
      };
    }),
  );
  return store;
}

/**
 * The URL view of a state (plan D79): `t` is `live` in live mode, `speed` only while playing,
 * `nightLevel` only while night is on below full brightness (plan D108), and no observer while
 * a geolocation prompt is up (OBS-1: the position is written once the user has answered).
 */
export function urlStateOf(state: SkyState): UrlState {
  const url: UrlState = {
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
  if (state.geo.status !== 'prompting') {
    url.body = state.observer.body;
    url.lat = state.observer.lat;
    url.lon = state.observer.lon;
    url.elev = state.observer.elev;
  }
  if (state.clock.mode === 'playing') {
    url.speed = state.clock.speed;
  }
  if (state.options.maglim !== null) {
    url.maglim = state.options.maglim;
  }
  if (state.dsoTypes !== null) {
    url.dso = state.dsoTypes;
  }
  if (state.options.night && state.options.nightLevel < NIGHT_LEVEL_MAX) {
    url.nightLevel = state.options.nightLevel;
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

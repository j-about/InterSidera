// @vitest-environment node
// The simulation store (plan D80): URL semantics on creation, clock actions through the D75
// control block, partial `applyUrl`, a stable `actions` object and selector subscriptions.

import { DAY_S, liveTt } from '../sky/math/time';
import {
  DEFAULT_LAYERS,
  DEFAULT_OPTIONS,
  DEFAULT_VIEW,
  GREENWICH,
  TT_MINUS_UTC_SEED_S,
  createSkyStore,
  defaultsUrlState,
  urlStateOf,
} from './store';
import type { MetaResponse } from './storeTypes';
import { serializeUrlState } from './url';

const T0 = 1_757_000_000_000;
const TT = 2460409.25;

/** A minimal but complete `/meta` answer (the store only stores it, plan D80). */
const META: MetaResponse = {
  api_version: '1.0.0',
  server_time: { tt: 2461285.5, utc: '2026-09-02T00:00:00Z', tt_minus_utc_seconds: 69.184 },
  ephemeris: { name: 'de440s.bsp', coverage_tt: [2396758.5, 2506000.5] },
  observers: [],
  coverage: {
    ephemeris_tt: [2396758.5, 2506000.5],
    delta_t: { observed_tt: [2441317.5, 2461349.5], predicted_until_tt: 2461714.5 },
    iau_rotation_reliable_tt: [2378496.5, 2524593.5],
    proper_motion_warning_years: 10000,
    mpc_elements: { warn_years: 2, error_years: 50 },
  },
  bodies: [],
  catalogs: {
    stars: {
      count: 117955,
      version: '1-abc',
      etag: 'stars-etag',
      epoch_tt: 2451545,
      magnitude_limit: 13.9,
      license: 'CC BY-SA 2.5',
      attribution: 'ESA Hipparcos; HYG',
    },
  },
  geocoder: { enabled: false, url: '', attribution: '', min_interval_ms: 1000 },
  limits: {
    max_samples: 64,
    max_minor_bodies: 100,
    max_targets: 200,
    speeds: [1, 10, 60],
    max_step_s: { moon: 3600, inner_planets: 21600, sun_and_outer: 86400, minor: 86400 },
  },
};

describe('createSkyStore', () => {
  it('starts live at Greenwich with the M3 defaults when the URL is empty', () => {
    const state = createSkyStore({}, T0).getState();
    expect(state.observer).toEqual(GREENWICH);
    expect(state.clock.mode).toBe('live');
    expect(state.clock.ttMinusUtc).toBe(TT_MINUS_UTC_SEED_S);
    expect(state.clock.tt).toBe(liveTt(T0, TT_MINUS_UTC_SEED_S));
    expect(state.view).toEqual(DEFAULT_VIEW);
    expect(state.layers).toEqual(DEFAULT_LAYERS);
    expect(state.layers.stars && state.layers.planets && state.layers.horizon).toBe(true);
    expect(state.layers.dso).toBe(false);
    expect(state.options).toEqual(DEFAULT_OPTIONS);
    expect(state.dsoTypes).toBeNull();
    expect(state.minor).toEqual([]);
    expect(state.selection).toBeNull();
    expect(state.meta).toBeNull();
    expect(state.health).toBeNull();
    expect(state.boot).toEqual({
      phase: 'health',
      attempt: 0,
      retryAtMs: null,
      progress: null,
      error: null,
    });
    expect(state.catalogs).toEqual({
      stars: 'idle',
      index: 'idle',
      dso: 'idle',
      constellations: 'idle',
    });
    expect(state.frames).toEqual({
      status: 'idle',
      window: null,
      lastError: null,
      snapshot: false,
      extrapolating: false,
      warnings: [],
    });
    expect(state.engine).toEqual({ kind: null, status: 'idle' });
  });

  it('pauses at t when speed is absent or zero', () => {
    const paused = createSkyStore({ t: TT }, T0).getState().clock;
    expect(paused).toMatchObject({
      mode: 'paused',
      speed: 0,
      ttAnchor: TT,
      wallAnchorMs: T0,
      tt: TT,
    });
    const zero = createSkyStore({ t: TT, speed: 0 }, T0).getState().clock;
    expect(zero.mode).toBe('paused');
  });

  it('plays from t at the signed speed', () => {
    const clock = createSkyStore({ t: TT, speed: -3600 }, T0).getState().clock;
    expect(clock).toMatchObject({
      mode: 'playing',
      speed: -3600,
      ttAnchor: TT,
      wallAnchorMs: T0,
      tt: TT,
    });
  });

  it('is live for t=live even with a speed, and ignores a speed without t', () => {
    expect(createSkyStore({ t: 'live', speed: 60 }, T0).getState().clock.mode).toBe('live');
    expect(createSkyStore({ speed: 60 }, T0).getState().clock.mode).toBe('live');
  });

  it('takes observer, view, layers, options, dso, minor and selection from the URL', () => {
    const state = createSkyStore(
      {
        body: 'mars',
        lat: 18.44,
        lon: 77.45,
        elev: -2500,
        az: 90,
        alt: 90,
        fov: 30,
        layers: ['stars', 'eqgrid'],
        ground: 'off',
        atm: false,
        refr: false,
        maglim: 6.5,
        labels: 0,
        night: true,
        lang: 'fr',
        dso: ['galaxy'],
        minor: ['a:1'],
        sel: 'hip:11767',
      },
      T0,
    ).getState();
    expect(state.observer).toEqual({ body: 'mars', lat: 18.44, lon: 77.45, elev: -2500 });
    // The camera pitch is clamped away from the pole (plan D72).
    expect(state.view).toEqual({ az: 90, alt: 89.99, fov: 30 });
    expect(state.layers).toEqual({
      ...Object.fromEntries(Object.keys(DEFAULT_LAYERS).map((k) => [k, false])),
      stars: true,
      eqgrid: true,
    });
    expect(state.options).toEqual({
      ground: 'off',
      atm: false,
      refr: false,
      maglim: 6.5,
      labels: 0,
      night: true,
      lang: 'fr',
    });
    expect(state.dsoTypes).toEqual(['galaxy']);
    expect(state.minor).toEqual(['a:1']);
    expect(state.selection).toBe('hip:11767');
  });

  it('fills a partial observer from the defaults', () => {
    expect(createSkyStore({ lat: 10 }, T0).getState().observer).toEqual({ ...GREENWICH, lat: 10 });
  });
});

describe('clock actions', () => {
  it('pause anchors live time, play resumes from it, live returns to the wall clock', () => {
    const store = createSkyStore({}, T0);
    const { actions } = store.getState();

    actions.pause(T0 + 1000);
    const paused = store.getState().clock;
    expect(paused.mode).toBe('paused');
    expect(paused.ttAnchor).toBe(liveTt(T0 + 1000, TT_MINUS_UTC_SEED_S));
    expect(paused.tt).toBe(paused.ttAnchor);

    actions.play(3600, T0 + 2000);
    const playing = store.getState().clock;
    expect(playing).toMatchObject({
      mode: 'playing',
      speed: 3600,
      ttAnchor: paused.ttAnchor,
      wallAnchorMs: T0 + 2000,
    });
    expect(playing.tt).toBe(paused.ttAnchor);

    actions.pause(T0 + 12_000);
    expect(store.getState().clock.tt).toBeCloseTo(paused.ttAnchor + 36000 / DAY_S, 9);

    actions.live(T0 + 20_000);
    const live = store.getState().clock;
    expect(live.mode).toBe('live');
    expect(live.tt).toBe(liveTt(T0 + 20_000, TT_MINUS_UTC_SEED_S));
  });

  it('play(0) pauses and setTime pauses at an explicit date', () => {
    const store = createSkyStore({}, T0);
    store.getState().actions.play(0, T0);
    expect(store.getState().clock.mode).toBe('paused');
    store.getState().actions.setTime(TT, T0 + 5);
    expect(store.getState().clock).toMatchObject({
      mode: 'paused',
      ttAnchor: TT,
      wallAnchorMs: T0 + 5,
      tt: TT,
    });
  });

  it('publishTt only writes when the mirror moved by more than 1e-6 day', () => {
    const store = createSkyStore({ t: TT }, T0);
    const before = store.getState();
    store.getState().actions.publishTt(TT + 5e-7);
    expect(store.getState()).toBe(before);
    expect(store.getState().clock).toBe(before.clock);
    store.getState().actions.publishTt(TT + 2e-6);
    expect(store.getState().clock.tt).toBe(TT + 2e-6);
    // The control block is untouched: only the mirror moved.
    expect(store.getState().clock.ttAnchor).toBe(TT);
  });

  it('setTtMinusUtc keeps the control block and feeds the next anchoring', () => {
    const store = createSkyStore({}, T0);
    store.getState().actions.setTtMinusUtc(70);
    expect(store.getState().clock.ttMinusUtc).toBe(70);
    store.getState().actions.pause(T0);
    expect(store.getState().clock.ttAnchor).toBe(liveTt(T0, 70));
  });

  it('defaults nowMs to Date.now()', () => {
    const spy = vi.spyOn(Date, 'now').mockReturnValue(T0 + 123);
    try {
      const store = createSkyStore();
      store.getState().actions.pause();
      expect(store.getState().clock.wallAnchorMs).toBe(T0 + 123);
      store.getState().actions.play(10);
      store.getState().actions.setTime(TT);
      store.getState().actions.live();
      store.getState().actions.applyUrl({ t: TT });
      expect(store.getState().clock.wallAnchorMs).toBe(T0 + 123);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('slice actions', () => {
  it('update their slice and nothing else', () => {
    const store = createSkyStore({}, T0);
    const { actions } = store.getState();
    const initial = store.getState();

    actions.setObserver({ body: 'moon', lat: 0.67, lon: 23.47, elev: 0 });
    expect(store.getState().observer.body).toBe('moon');
    expect(store.getState().clock).toBe(initial.clock);

    actions.setView({ az: 370, alt: -95 });
    expect(store.getState().view).toEqual({ az: 10, alt: -89.99, fov: 60 });
    actions.setView({ fov: 500 });
    expect(store.getState().view.fov).toBe(120);

    actions.setLayer('eqgrid', true);
    expect(store.getState().layers.eqgrid).toBe(true);
    expect(store.getState().layers.stars).toBe(true);

    actions.setOptions({ night: true, maglim: 5 });
    expect(store.getState().options).toEqual({ ...DEFAULT_OPTIONS, night: true, maglim: 5 });

    actions.setDsoTypes(['nebula']);
    expect(store.getState().dsoTypes).toEqual(['nebula']);
    actions.setDsoTypes(null);
    expect(store.getState().dsoTypes).toBeNull();

    actions.setMinor(['c:1P']);
    expect(store.getState().minor).toEqual(['c:1P']);

    actions.select('moon');
    expect(store.getState().selection).toBe('moon');
    actions.select(null);
    expect(store.getState().selection).toBeNull();

    actions.setMeta(META);
    expect(store.getState().meta).toBe(META);
    expect(store.getState().clock).toBe(initial.clock);

    actions.setHealth({ status: 'degraded', version: '0.1.0', missing: ['mpc'] });
    expect(store.getState().health?.status).toBe('degraded');
    actions.setHealth(null);
    expect(store.getState().health).toBeNull();

    actions.setBoot({ phase: 'meta', attempt: 2 });
    expect(store.getState().boot).toEqual({
      phase: 'meta',
      attempt: 2,
      retryAtMs: null,
      progress: null,
      error: null,
    });

    actions.setCatalogStatus('stars', 'loading');
    expect(store.getState().catalogs).toEqual({
      stars: 'loading',
      index: 'idle',
      dso: 'idle',
      constellations: 'idle',
    });

    actions.setFrames({ status: 'loading', snapshot: true });
    expect(store.getState().frames).toMatchObject({
      status: 'loading',
      snapshot: true,
      window: null,
    });

    actions.setEngine({ kind: 'webgl2', status: 'running' });
    expect(store.getState().engine).toEqual({ kind: 'webgl2', status: 'running' });
  });

  it('keeps the same actions object across changes', () => {
    const store = createSkyStore({}, T0);
    const { actions } = store.getState();
    actions.setLayer('meridian', true);
    actions.pause(T0);
    actions.setObserver({ body: 'mars', lat: 0, lon: 0, elev: 0 });
    expect(store.getState().actions).toBe(actions);
    expect(store.getInitialState().actions).toBe(actions);
  });
});

describe('applyUrl', () => {
  it('applies only the present fields', () => {
    const store = createSkyStore({ t: TT, lat: 10, lon: 20 }, T0);
    const { actions } = store.getState();
    const before = store.getState();

    actions.applyUrl({ lat: 30 }, T0 + 1);
    expect(store.getState().observer).toEqual({ body: 'earth', lat: 30, lon: 20, elev: 0 });
    expect(store.getState().clock).toBe(before.clock);
    expect(store.getState().view).toBe(before.view);
    expect(store.getState().layers).toBe(before.layers);
    // No option key in the URL: the same `options` object, so `options` subscribers stay quiet.
    expect(store.getState().options).toBe(before.options);
    actions.applyUrl({ maglim: 6 }, T0 + 1);
    expect(store.getState().options).toEqual({ ...before.options, maglim: 6 });

    actions.applyUrl({ speed: 60 }, T0 + 2);
    expect(store.getState().clock).toBe(before.clock);

    actions.applyUrl({ t: 'live' }, T0 + 3);
    expect(store.getState().clock.mode).toBe('live');
    expect(store.getState().clock.wallAnchorMs).toBe(T0 + 3);

    actions.applyUrl({ t: TT + 1, speed: 600 }, T0 + 4);
    expect(store.getState().clock).toMatchObject({
      mode: 'playing',
      speed: 600,
      ttAnchor: TT + 1,
      tt: TT + 1,
    });

    actions.applyUrl({ az: 45 }, T0 + 5);
    expect(store.getState().view).toEqual({ az: 45, alt: 20, fov: 60 });

    actions.applyUrl({ layers: [], night: true, sel: 'moon', dso: [], minor: ['a:2'] }, T0 + 6);
    expect(Object.values(store.getState().layers).every((on) => !on)).toBe(true);
    expect(store.getState().options.night).toBe(true);
    expect(store.getState().options.lang).toBe('en');
    expect(store.getState().selection).toBe('moon');
    expect(store.getState().dsoTypes).toEqual([]);
    expect(store.getState().minor).toEqual(['a:2']);

    actions.applyUrl({}, T0 + 7);
    expect(store.getState().selection).toBe('moon');
  });
});

describe('subscribe with a selector', () => {
  it('fires only when the selected slice changes', () => {
    const store = createSkyStore({}, T0);
    const listener = vi.fn();
    const unsubscribe = store.subscribe((state) => state.view, listener);
    store.getState().actions.setLayer('azgrid', true);
    store.getState().actions.pause(T0);
    expect(listener).not.toHaveBeenCalled();
    store.getState().actions.setView({ az: 12 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith({ az: 12, alt: 20, fov: 60 }, DEFAULT_VIEW);
    unsubscribe();
    store.getState().actions.setView({ az: 13 });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('supports the plain listener form and an equality function', () => {
    const store = createSkyStore({}, T0);
    const plain = vi.fn();
    const rounded = vi.fn();
    store.subscribe(plain);
    store.subscribe((state) => state.view.az, rounded, {
      equalityFn: (a, b) => Math.round(a) === Math.round(b),
    });
    store.getState().actions.setView({ az: 0.2 });
    store.getState().actions.setView({ az: 0.4 });
    expect(plain).toHaveBeenCalledTimes(2);
    expect(rounded).not.toHaveBeenCalled();
    store.getState().actions.setView({ az: 1 });
    expect(rounded).toHaveBeenCalledTimes(1);
  });
});

describe('urlStateOf and defaultsUrlState', () => {
  it('serializes the default store to the always-written keys only', () => {
    const store = createSkyStore({}, T0);
    expect(serializeUrlState(urlStateOf(store.getState()), defaultsUrlState())).toBe(
      'body=earth&lat=51.48&lon=0&elev=0&t=live&az=0&alt=20&fov=60',
    );
  });

  it('writes t=live in live mode, the mirror otherwise, and speed only while playing', () => {
    const store = createSkyStore({}, T0);
    expect(urlStateOf(store.getState())).toMatchObject({ t: 'live' });
    expect(urlStateOf(store.getState())).not.toHaveProperty('speed');
    store.getState().actions.setTime(TT, T0);
    expect(urlStateOf(store.getState())).toMatchObject({ t: TT });
    expect(urlStateOf(store.getState())).not.toHaveProperty('speed');
    store.getState().actions.play(-60, T0);
    expect(urlStateOf(store.getState())).toMatchObject({ t: TT, speed: -60 });
  });

  it('omits maglim, dso and sel when they are null', () => {
    const store = createSkyStore({}, T0);
    const url = urlStateOf(store.getState());
    expect(url).not.toHaveProperty('maglim');
    expect(url).not.toHaveProperty('dso');
    expect(url).not.toHaveProperty('sel');
    store.getState().actions.setOptions({ maglim: 7 });
    store.getState().actions.setDsoTypes(['galaxy']);
    store.getState().actions.select('hip:1');
    expect(urlStateOf(store.getState())).toMatchObject({
      maglim: 7,
      dso: ['galaxy'],
      sel: 'hip:1',
    });
  });

  it('lists the layers in canonical order and mirrors every option', () => {
    const store = createSkyStore(
      { layers: ['eqgrid', 'stars'], night: true, labels: 3, lang: 'fr' },
      T0,
    );
    expect(urlStateOf(store.getState())).toMatchObject({
      layers: ['stars', 'eqgrid'],
      ground: 'dim',
      atm: true,
      refr: true,
      minor: [],
      labels: 3,
      lang: 'fr',
      night: true,
    });
    expect(defaultsUrlState()).toEqual({
      body: 'earth',
      lat: 51.48,
      lon: 0,
      elev: 0,
      t: 'live',
      az: 0,
      alt: 20,
      fov: 60,
      layers: ['stars', 'planets', 'horizon'],
      ground: 'dim',
      atm: true,
      refr: true,
      minor: [],
      labels: 2,
      lang: 'en',
      night: false,
    });
  });
});

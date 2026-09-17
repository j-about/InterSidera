// @vitest-environment node
// The simulation store (plan D80, D92): URL semantics on creation, clock actions through the D75
// control block (stepping, the coverage stop), the session-only slices and their actions, partial
// `applyUrl`, a stable `actions` object and selector subscriptions.

import type { CatalogBundle } from '../api/catalogs';
import { DAY_S, calendarFromJd, jdFromCalendar, liveTt, ttFromUtcJd } from '../sky/math/time';
import type { CalendarFields } from '../sky/math/time';
import { COVERAGE_GUARD_D } from './frames';
import {
  DEFAULT_LAYERS,
  DEFAULT_OPTIONS,
  DEFAULT_VIEW,
  GREENWICH,
  MINOR_DEFAULTS_SHOWN,
  TT_MINUS_UTC_SEED_S,
  createSkyStore,
  defaultsUrlState,
  urlStateOf,
} from './store';
import type { MetaResponse, MinorBodySummary } from './storeTypes';
import { createArState, createSelectionReadout } from './types';
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

function summary(id: string): MinorBodySummary {
  return { id, designation: id, kind: 'asteroid', elements_epoch_tt: 2460200.5 };
}

/** The TT of a UTC calendar date under the seed TT - UTC. */
function ttOfUtc(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): number {
  return ttFromUtcJd(jdFromCalendar(year, month, day, hour, minute, second), TT_MINUS_UTC_SEED_S);
}

function utcCalendarOf(tt: number): CalendarFields {
  return calendarFromJd(
    { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 },
    tt - TT_MINUS_UTC_SEED_S / DAY_S,
  );
}

describe('createSkyStore', () => {
  it('starts live at Greenwich with the defaults when the URL is empty', () => {
    const state = createSkyStore({}, T0).getState();
    expect(state.observer).toEqual(GREENWICH);
    expect(state.clock.mode).toBe('live');
    expect(state.clock.ttMinusUtc).toBe(TT_MINUS_UTC_SEED_S);
    expect(state.clock.tt).toBe(liveTt(T0, TT_MINUS_UTC_SEED_S));
    expect(state.clock.lstHours).toBeNaN();
    expect(state.view).toEqual(DEFAULT_VIEW);
    expect(state.layers).toEqual(DEFAULT_LAYERS);
    // Stars, planets, deep-sky objects, constellation lines and the horizon are on (plan Q30).
    expect(state.layers).toMatchObject({
      stars: true,
      planets: true,
      dso: true,
      clines: true,
      horizon: true,
      minor: false,
      cnames: false,
      cbounds: false,
      azgrid: false,
      eqgrid: false,
      ecliptic: false,
      meridian: false,
    });
    expect(state.options).toEqual(DEFAULT_OPTIONS);
    expect(state.options.nightLevel).toBe(1);
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
      retrySeq: 0,
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
      failing: null,
      coverageStop: null,
      minor: [],
    });
    expect(state.engine).toEqual({ kind: null, status: 'idle' });
    // The session-only slices of plan D92.
    expect(state.geo).toEqual({ status: 'idle' });
    expect(state.geocoder).toEqual({
      enabled: true,
      busy: false,
      lastRequestMs: -Infinity,
      results: [],
      error: null,
    });
    expect(state.ui).toEqual({
      panel: null,
      sheet: 'collapsed',
      dialog: null,
      stepUnit: 'hour',
      shortcuts: true,
      hintDismissed: false,
      toast: null,
      lastSpeed: 1,
    });
    expect(state.follow).toBe(false);
    expect(state.labels).toEqual({ visible: [] });
    expect(state.readout).toBeNull();
    expect(state.details).toEqual({
      id: null,
      status: 'idle',
      entry: null,
      tt: NaN,
      refraction: false,
      con: null,
      error: null,
    });
    expect(state.minorBodies).toEqual({ defaults: null, status: 'idle', shown: 20 });
    expect(MINOR_DEFAULTS_SHOWN).toBe(20);
    expect(state.bundle).toBeNull();
    expect(state.centreRequest).toBeNull();
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
    // `night=1` is night at full brightness (plan D108).
    expect(state.options).toEqual({
      ground: 'off',
      atm: false,
      refr: false,
      maglim: 6.5,
      labels: 0,
      night: true,
      nightLevel: 1,
      lang: 'fr',
    });
    expect(state.dsoTypes).toEqual(['galaxy']);
    expect(state.minor).toEqual(['a:1']);
    expect(state.selection).toBe('hip:11767');
  });

  it('takes the night brightness from the URL', () => {
    expect(createSkyStore({ night: true, nightLevel: 0.6 }, T0).getState().options).toMatchObject({
      night: true,
      nightLevel: 0.6,
    });
    // Off leaves the brightness at its default; it is not written while off.
    expect(createSkyStore({ night: false }, T0).getState().options).toMatchObject({
      night: false,
      nightLevel: 1,
    });
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

  it('remembers the last running speed for Play and Space in ui.lastSpeed', () => {
    const store = createSkyStore({}, T0);
    const { actions } = store.getState();
    expect(store.getState().ui.lastSpeed).toBe(1); // live counts as 1x
    actions.play(3600, T0 + 1000);
    expect(store.getState().ui.lastSpeed).toBe(3600);
    actions.pause(T0 + 2000);
    expect(store.getState().ui.lastSpeed).toBe(3600); // a pause keeps the speed it interrupted
    actions.play(-600, T0 + 3000);
    expect(store.getState().ui.lastSpeed).toBe(-600);
    actions.setTime(TT, T0 + 4000);
    expect(store.getState().ui.lastSpeed).toBe(-600);
    actions.live(T0 + 5000);
    expect(store.getState().ui.lastSpeed).toBe(1);
    // The URL's own clock statement seeds it; a paused URL starts at 1x.
    expect(createSkyStore({ t: TT, speed: 600 }, T0).getState().ui.lastSpeed).toBe(600);
    expect(createSkyStore({ t: TT, speed: 0 }, T0).getState().ui.lastSpeed).toBe(1);
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

  it('publishTt writes when the mirror moved by more than 1e-6 day or the sidereal time changed', () => {
    const store = createSkyStore({ t: TT }, T0);
    const before = store.getState();
    store.getState().actions.publishTt(TT + 5e-7, NaN);
    expect(store.getState()).toBe(before);
    expect(store.getState().clock).toBe(before.clock);
    store.getState().actions.publishTt(TT + 2e-6, NaN);
    expect(store.getState().clock.tt).toBe(TT + 2e-6);
    expect(store.getState().clock.lstHours).toBeNaN();
    // The control block is untouched: only the mirror moved.
    expect(store.getState().clock.ttAnchor).toBe(TT);
    // A sidereal time alone is a change (NaN -> 5.25), and so is 5.25 -> 5.26, but not NaN -> NaN
    // nor 5.25 -> 5.25.
    const mirrored = store.getState();
    store.getState().actions.publishTt(TT + 2e-6, 5.25);
    expect(store.getState()).not.toBe(mirrored);
    expect(store.getState().clock.lstHours).toBe(5.25);
    const withLst = store.getState();
    store.getState().actions.publishTt(TT + 2e-6, 5.25);
    expect(store.getState()).toBe(withLst);
    store.getState().actions.publishTt(TT + 2e-6, 5.26);
    expect(store.getState().clock.lstHours).toBe(5.26);
    // NaN (off Earth) replaces a value, then stays quiet.
    store.getState().actions.publishTt(TT + 2e-6, NaN);
    expect(store.getState().clock.lstHours).toBeNaN();
    const offEarth = store.getState();
    store.getState().actions.publishTt(TT + 2e-6, NaN);
    expect(store.getState()).toBe(offEarth);
  });

  it('carries the sidereal time through the clock actions and applyUrl', () => {
    const store = createSkyStore({ t: TT }, T0);
    store.getState().actions.publishTt(TT, 5.25);
    store.getState().actions.pause(T0);
    expect(store.getState().clock.lstHours).toBe(5.25);
    store.getState().actions.play(60, T0);
    expect(store.getState().clock.lstHours).toBe(5.25);
    store.getState().actions.live(T0);
    expect(store.getState().clock.lstHours).toBe(5.25);
    store.getState().actions.setTime(TT, T0);
    expect(store.getState().clock.lstHours).toBe(5.25);
    store.getState().actions.stepTime(60, T0);
    expect(store.getState().clock.lstHours).toBe(5.25);
    store.getState().actions.stopAtBound([TT - 1, TT + 1], T0);
    expect(store.getState().clock.lstHours).toBe(5.25);
    store.getState().actions.applyUrl({ t: TT + 1 }, T0);
    expect(store.getState().clock.lstHours).toBe(5.25);
    store.getState().actions.setTtMinusUtc(70);
    expect(store.getState().clock.lstHours).toBe(5.25);
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
      store.getState().actions.stepTime(60);
      expect(store.getState().clock.wallAnchorMs).toBe(T0 + 123);
      store.getState().actions.stopAtBound([TT - 1, TT + 1]);
      expect(store.getState().clock.wallAnchorMs).toBe(T0 + 123);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('stopAtBound', () => {
  const range: [number, number] = [2400000.5, 2450000.5];

  it('pauses one guard inside the bound the running clock left and records the stop', () => {
    const store = createSkyStore({ t: range[1] - 1, speed: 86400 }, T0);
    // A day of simulated time per second: after ten seconds the clock is well past the end.
    store.getState().actions.stopAtBound(range, T0 + 10_000);
    const { clock, frames } = store.getState();
    expect(clock).toMatchObject({
      mode: 'paused',
      speed: 0,
      ttAnchor: range[1] - COVERAGE_GUARD_D,
      wallAnchorMs: T0 + 10_000,
      tt: range[1] - COVERAGE_GUARD_D,
    });
    expect(frames.coverageStop).toEqual({ rangeTt: range });
    // The rest of the frames slice is untouched.
    expect(frames.status).toBe('idle');
    expect(frames.minor).toEqual([]);
  });

  it('pauses where the clock is when the time itself lies inside the range', () => {
    const store = createSkyStore({ t: range[0] + 1 }, T0);
    store.getState().actions.stopAtBound(range, T0);
    expect(store.getState().clock.tt).toBe(range[0] + 1);
    expect(store.getState().frames.coverageStop).toEqual({ rangeTt: range });
    // Before the start: one guard inside it.
    store.getState().actions.setTime(range[0] - 5, T0);
    expect(store.getState().frames.coverageStop).toBeNull();
    store.getState().actions.stopAtBound(range, T0);
    expect(store.getState().clock.tt).toBe(range[0] + COVERAGE_GUARD_D);
  });

  it('is lifted by play, live, setTime, pause, stepTime and a URL time, and only then', () => {
    const store = createSkyStore({ t: TT }, T0);
    const { actions } = store.getState();
    const lifters: (() => void)[] = [
      () => {
        // Back to an instant inside coverage (popstate) is a user time change too.
        actions.applyUrl({ t: TT }, T0);
      },
      () => {
        actions.play(60, T0);
      },
      () => {
        actions.live(T0);
      },
      () => {
        actions.setTime(TT, T0);
      },
      () => {
        actions.pause(T0);
      },
      () => {
        actions.stepTime(60, T0);
      },
    ];
    for (const lift of lifters) {
      actions.stopAtBound(range, T0);
      expect(store.getState().frames.coverageStop).not.toBeNull();
      lift();
      expect(store.getState().frames.coverageStop).toBeNull();
    }
    // Without a stop set, a clock action leaves the frames object alone (no subscriber wake-up).
    const frames = store.getState().frames;
    actions.pause(T0 + 1);
    expect(store.getState().frames).toBe(frames);
    // Other actions do not lift it.
    actions.stopAtBound(range, T0);
    actions.setView({ az: 10 });
    actions.setLayer('minor', true);
    actions.publishTt(TT, NaN);
    actions.setFrames({ status: 'loading' });
    // A URL without a time (an observer or view change) is not a time change.
    actions.applyUrl({ lat: 10, az: 20, night: true }, T0);
    expect(store.getState().frames.coverageStop).toEqual({ rangeTt: range });
  });
});

describe('stepTime', () => {
  it('steps a paused clock by seconds and stays paused', () => {
    const store = createSkyStore({ t: TT }, T0);
    store.getState().actions.stepTime(3600, T0 + 500);
    expect(store.getState().clock).toMatchObject({
      mode: 'paused',
      speed: 0,
      ttAnchor: TT + 3600 / DAY_S,
      wallAnchorMs: T0 + 500,
      tt: TT + 3600 / DAY_S,
    });
    store.getState().actions.stepTime(-86400, T0 + 600);
    expect(store.getState().clock.tt).toBeCloseTo(TT + 3600 / DAY_S - 1, 9);
  });

  it('steps from the time the engine renders now, not from the mirror, and keeps playing', () => {
    const store = createSkyStore({ t: TT, speed: 3600 }, T0);
    // The mirror is stale by design (<= 2 Hz): the step must not read it.
    store.getState().actions.publishTt(TT - 5, NaN);
    // Ten seconds at 3600x = ten hours of simulated time.
    store.getState().actions.stepTime(60, T0 + 10_000);
    const expected = TT + (10 * 3600) / DAY_S + 60 / DAY_S;
    expect(store.getState().clock).toMatchObject({ mode: 'playing', speed: 3600 });
    expect(store.getState().clock.ttAnchor).toBeCloseTo(expected, 9);
    expect(store.getState().clock.wallAnchorMs).toBe(T0 + 10_000);
    expect(store.getState().clock.tt).toBeCloseTo(expected, 9);
  });

  it('turns a live clock into playing at 1x from the stepped time', () => {
    const store = createSkyStore({}, T0);
    store.getState().actions.stepTime(-600, T0 + 2000);
    const expected = liveTt(T0 + 2000, TT_MINUS_UTC_SEED_S) - 600 / DAY_S;
    expect(store.getState().clock).toMatchObject({
      mode: 'playing',
      speed: 1,
      wallAnchorMs: T0 + 2000,
    });
    expect(store.getState().clock.ttAnchor).toBeCloseTo(expected, 9);
  });

  it('steps by a calendar year on the same UTC date and time', () => {
    const start = ttOfUtc(2024, 4, 8, 18, 30, 15.5);
    const store = createSkyStore({ t: start }, T0);
    store.getState().actions.stepTime({ years: 1 }, T0);
    let c = utcCalendarOf(store.getState().clock.tt);
    expect([c.year, c.month, c.day, c.hour, c.minute]).toEqual([2025, 4, 8, 18, 30]);
    // A Julian Date near 2.46e6 resolves seconds to about 4e-5 s (float64 ulp).
    expect(c.second).toBeCloseTo(15.5, 3);
    // 2024 is a leap year, 2025 is not: 366 days forward, 365 back.
    expect(store.getState().clock.tt - start).toBeCloseTo(365, 6);
    store.getState().actions.stepTime({ years: -1 }, T0);
    store.getState().actions.stepTime({ years: -1 }, T0);
    c = utcCalendarOf(store.getState().clock.tt);
    expect([c.year, c.month, c.day]).toEqual([2023, 4, 8]);
    expect(store.getState().clock.tt - start).toBeCloseTo(-366, 6);
    expect(store.getState().clock.mode).toBe('paused');
  });

  it('lands February 29 on February 28 when the target year has none', () => {
    const store = createSkyStore({ t: ttOfUtc(2024, 2, 29, 12) }, T0);
    store.getState().actions.stepTime({ years: 1 }, T0);
    let c = utcCalendarOf(store.getState().clock.tt);
    expect([c.year, c.month, c.day, c.hour]).toEqual([2025, 2, 28, 12]);
    // Back to a leap year the 28th stays the 28th (the date is not remembered).
    store.getState().actions.stepTime({ years: -1 }, T0);
    c = utcCalendarOf(store.getState().clock.tt);
    expect([c.year, c.month, c.day]).toEqual([2024, 2, 28]);
    // 2100 is not a leap year, 2000 and 2400 are (proleptic Gregorian).
    const century = createSkyStore({ t: ttOfUtc(2096, 2, 29) }, T0);
    century.getState().actions.stepTime({ years: 1 }, T0);
    c = utcCalendarOf(century.getState().clock.tt);
    expect([c.year, c.month, c.day]).toEqual([2097, 2, 28]);
    const millennium = createSkyStore({ t: ttOfUtc(1999, 2, 28) }, T0);
    millennium.getState().actions.stepTime({ years: 1 }, T0);
    c = utcCalendarOf(millennium.getState().clock.tt);
    expect([c.year, c.month, c.day]).toEqual([2000, 2, 28]);
  });

  it('steps a year across negative years, year zero and a leap day there', () => {
    // 45 BC is the astronomical year -44; -44 % 4 === 0 so it is a leap year, -45 is not.
    const store = createSkyStore({ t: ttOfUtc(-44, 2, 29, 6) }, T0);
    store.getState().actions.stepTime({ years: -1 }, T0);
    let c = utcCalendarOf(store.getState().clock.tt);
    expect([c.year, c.month, c.day, c.hour]).toEqual([-45, 2, 28, 6]);
    const zero = createSkyStore({ t: ttOfUtc(-1, 7, 1) }, T0);
    zero.getState().actions.stepTime({ years: 1 }, T0);
    c = utcCalendarOf(zero.getState().clock.tt);
    expect([c.year, c.month, c.day]).toEqual([0, 7, 1]);
    zero.getState().actions.stepTime({ years: 1 }, T0);
    c = utcCalendarOf(zero.getState().clock.tt);
    expect([c.year, c.month, c.day]).toEqual([1, 7, 1]);
    // Year 0 is a leap year (divisible by 400): its Feb 29 falls back in year 1.
    const leapZero = createSkyStore({ t: ttOfUtc(0, 2, 29) }, T0);
    leapZero.getState().actions.stepTime({ years: 1 }, T0);
    c = utcCalendarOf(leapZero.getState().clock.tt);
    expect([c.year, c.month, c.day]).toEqual([1, 2, 28]);
    // -100 is not a leap year (divisible by 100, not by 400).
    const minusCentury = createSkyStore({ t: ttOfUtc(-101, 2, 28) }, T0);
    minusCentury.getState().actions.stepTime({ years: 1 }, T0);
    c = utcCalendarOf(minusCentury.getState().clock.tt);
    expect([c.year, c.month, c.day]).toEqual([-100, 2, 28]);
    expect(store.getState().clock.tt - ttOfUtc(-44, 2, 29, 6)).toBeCloseTo(-366, 6);
  });

  it('uses the current TT - UTC for the calendar arithmetic', () => {
    // Under a different offset the same TT is another UTC date near midnight.
    const store = createSkyStore({ t: ttOfUtc(2024, 4, 8, 23, 59, 40) }, T0);
    store.getState().actions.setTtMinusUtc(TT_MINUS_UTC_SEED_S + 30);
    store.getState().actions.stepTime({ years: 1 }, T0);
    const c = calendarFromJd(
      { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 },
      store.getState().clock.tt - (TT_MINUS_UTC_SEED_S + 30) / DAY_S,
    );
    expect([c.year, c.month, c.day, c.hour, c.minute]).toEqual([2025, 4, 8, 23, 59]);
    expect(c.second).toBeCloseTo(10, 3);
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
    expect(store.getState().geo).toBe(initial.geo);

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
      retrySeq: 0,
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
      coverageStop: null,
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
    actions.openPanel('time');
    expect(store.getState().actions).toBe(actions);
    expect(store.getInitialState().actions).toBe(actions);
  });

  it('publishes the readout and the visible labels', () => {
    const store = createSkyStore({}, T0);
    const { actions } = store.getState();
    const readout = createSelectionReadout();
    readout.id = 'moon';
    readout.valid = true;
    readout.alt = 12.5;
    actions.publishReadout(readout);
    expect(store.getState().readout).toBe(readout);
    actions.publishReadout(null);
    expect(store.getState().readout).toBeNull();
    const labels = [{ id: 'moon', kind: 'body' as const, text: 'Moon' }];
    actions.setVisibleLabels(labels);
    expect(store.getState().labels.visible).toBe(labels);
  });

  it('deselecting also stops following', () => {
    const store = createSkyStore({}, T0);
    const { actions } = store.getState();
    actions.setFollow(true);
    expect(store.getState().follow).toBe(true);
    actions.select('moon');
    expect(store.getState().follow).toBe(true);
    actions.select('mars');
    expect(store.getState().follow).toBe(true);
    actions.select(null);
    expect(store.getState().follow).toBe(false);
    actions.setFollow(false);
    expect(store.getState().follow).toBe(false);
  });

  it('tracks geolocation and clears a pending prompt when the observer is set by hand', () => {
    const store = createSkyStore({}, T0);
    const { actions } = store.getState();
    for (const status of [
      'unsupported',
      'insecure',
      'prompting',
      'granted',
      'denied',
      'unavailable',
      'timeout',
      'idle',
    ] as const) {
      actions.setGeo(status);
      expect(store.getState().geo).toEqual({ status });
    }
    actions.setGeo('prompting');
    actions.setObserver({ body: 'earth', lat: 48.86, lon: 2.35, elev: 35 });
    expect(store.getState().geo.status).toBe('idle');
    // Any other status is left alone by an observer change.
    actions.setGeo('granted');
    actions.setObserver({ body: 'earth', lat: 40, lon: -3.7, elev: 650 });
    expect(store.getState().geo.status).toBe('granted');
    // The observer branch of `applyUrl` behaves the same; other URL fields do not touch it.
    actions.setGeo('prompting');
    actions.applyUrl({ az: 12 }, T0);
    expect(store.getState().geo.status).toBe('prompting');
    actions.applyUrl({ lat: 12 }, T0);
    expect(store.getState().geo.status).toBe('idle');
  });

  it('merges geocoder, ui and details patches', () => {
    const store = createSkyStore({}, T0);
    const { actions } = store.getState();
    actions.setGeocoder({ busy: true, lastRequestMs: T0 });
    expect(store.getState().geocoder).toEqual({
      enabled: true,
      busy: true,
      lastRequestMs: T0,
      results: [],
      error: null,
    });
    const results = [
      {
        placeId: 1,
        displayName: 'Paris, France',
        lat: 48.86,
        lon: 2.35,
        category: 'boundary',
        type: 'administrative',
      },
    ];
    actions.setGeocoder({ busy: false, results, error: null });
    expect(store.getState().geocoder.results).toBe(results);
    actions.setGeocoder({ enabled: false, error: 'blocked' });
    expect(store.getState().geocoder).toMatchObject({ enabled: false, error: 'blocked', results });

    actions.setUi({ stepUnit: 'day', shortcuts: false });
    expect(store.getState().ui).toMatchObject({
      stepUnit: 'day',
      shortcuts: false,
      panel: null,
      sheet: 'collapsed',
    });

    const entry = {
      id: 'moon',
      alt_deg: 10,
      az_deg: 20,
      ra_icrs_deg: 30,
      dec_icrs_deg: 40,
      ra_date_deg: 31,
      dec_date_deg: 41,
      constellation: 'Tau',
    };
    actions.setDetails({ id: 'moon', status: 'loading' });
    expect(store.getState().details).toMatchObject({ id: 'moon', status: 'loading', entry: null });
    actions.setDetails({ status: 'ready', entry, tt: TT, refraction: true, con: 'Tau' });
    expect(store.getState().details).toEqual({
      id: 'moon',
      status: 'ready',
      entry,
      tt: TT,
      refraction: true,
      con: 'Tau',
      error: null,
    });
    actions.setDetails({
      status: 'error',
      error: { status: 422, slug: 'outside-coverage', rangeTt: [1, 2] },
    });
    expect(store.getState().details.error).toEqual({
      status: 422,
      slug: 'outside-coverage',
      rangeTt: [1, 2],
    });
  });

  it('opens and closes panels and dialogs, shows toasts with increasing seq, dismisses the hint', () => {
    const store = createSkyStore({}, T0);
    const { actions } = store.getState();
    actions.openPanel('observer');
    expect(store.getState().ui).toMatchObject({ panel: 'observer', sheet: 'expanded' });
    actions.openPanel('details');
    expect(store.getState().ui).toMatchObject({ panel: 'details', sheet: 'expanded' });
    actions.closePanel();
    expect(store.getState().ui).toMatchObject({ panel: null, sheet: 'collapsed' });
    // The dialog is independent of the panel.
    actions.openPanel('layers');
    actions.openDialog('about');
    expect(store.getState().ui).toMatchObject({ panel: 'layers', dialog: 'about' });
    actions.openDialog('timeEditor');
    expect(store.getState().ui.dialog).toBe('timeEditor');
    actions.closeDialog();
    expect(store.getState().ui).toMatchObject({ panel: 'layers', dialog: null });

    actions.showToast('share.copied');
    expect(store.getState().ui.toast).toEqual({ seq: 1, key: 'share.copied' });
    actions.showToast('share.copied');
    expect(store.getState().ui.toast).toEqual({ seq: 2, key: 'share.copied' });
    // Clearing the toast does not reset the sequence: the next one is still told apart.
    actions.setUi({ toast: null });
    expect(store.getState().ui.toast).toBeNull();
    actions.showToast('export.failed');
    expect(store.getState().ui.toast).toEqual({ seq: 3, key: 'export.failed' });

    expect(store.getState().ui.hintDismissed).toBe(false);
    actions.dismissHint();
    expect(store.getState().ui.hintDismissed).toBe(true);
    expect(store.getState().ui).toMatchObject({ panel: 'layers', stepUnit: 'hour' });
  });

  it('clamps the night brightness to [0.3, 1] and ignores a non-finite value', () => {
    const store = createSkyStore({}, T0);
    const { actions } = store.getState();
    actions.setNightLevel(0.6);
    expect(store.getState().options.nightLevel).toBe(0.6);
    actions.setNightLevel(0.1);
    expect(store.getState().options.nightLevel).toBe(0.3);
    actions.setNightLevel(7);
    expect(store.getState().options.nightLevel).toBe(1);
    actions.setNightLevel(0.3);
    expect(store.getState().options.nightLevel).toBe(0.3);
    const options = store.getState().options;
    actions.setNightLevel(NaN);
    actions.setNightLevel(Infinity);
    expect(store.getState().options).toBe(options);
    // The other options are untouched.
    expect(store.getState().options).toEqual({ ...DEFAULT_OPTIONS, nightLevel: 0.3 });
  });

  it('pins minor bodies up to the cap and unpins them', () => {
    const store = createSkyStore({}, T0);
    const { actions } = store.getState();
    expect(actions.pinMinor('a:1')).toBe(true);
    expect(actions.pinMinor('c:1P')).toBe(true);
    expect(store.getState().minor).toEqual(['a:1', 'c:1P']);
    // Already pinned: true, unchanged.
    const pinned = store.getState().minor;
    expect(actions.pinMinor('a:1')).toBe(true);
    expect(store.getState().minor).toBe(pinned);
    actions.unpinMinor('a:1');
    expect(store.getState().minor).toEqual(['c:1P']);
    // Unpinning what is not pinned changes nothing.
    const afterUnpin = store.getState().minor;
    actions.unpinMinor('a:433');
    expect(store.getState().minor).toBe(afterUnpin);

    // The cap: 100 before `/meta`, then `limits.max_minor_bodies`.
    actions.setMinor(Array.from({ length: 100 }, (_, i) => `a:${String(i + 1)}`));
    expect(actions.pinMinor('a:1000')).toBe(false);
    expect(store.getState().minor).toHaveLength(100);
    expect(actions.pinMinor('a:50')).toBe(true);
    actions.setMeta({ ...META, limits: { ...META.limits, max_minor_bodies: 3 } });
    actions.setMinor(['a:1', 'a:2']);
    expect(actions.pinMinor('a:3')).toBe(true);
    expect(actions.pinMinor('a:4')).toBe(false);
    expect(store.getState().minor).toEqual(['a:1', 'a:2', 'a:3']);
  });

  it('records the default minor bodies and shows more of them', () => {
    const store = createSkyStore({}, T0);
    const { actions } = store.getState();
    // Without defaults "show more" leaves the count at twenty.
    actions.showMoreMinor();
    expect(store.getState().minorBodies).toEqual({ defaults: null, status: 'idle', shown: 20 });
    actions.setMinorDefaults(null, 'loading');
    expect(store.getState().minorBodies).toEqual({ defaults: null, status: 'loading', shown: 20 });
    const list = Array.from({ length: 35 }, (_, i) => summary(`a:${String(i + 1)}`));
    actions.setMinorDefaults(list, 'ready');
    expect(store.getState().minorBodies).toEqual({ defaults: list, status: 'ready', shown: 20 });
    actions.showMoreMinor();
    expect(store.getState().minorBodies.shown).toBe(35);
    actions.setMinorDefaults(null, 'error');
    expect(store.getState().minorBodies).toEqual({ defaults: null, status: 'error', shown: 35 });
  });

  it('stores the catalog bundle', () => {
    const store = createSkyStore({}, T0);
    const bundle = { starsEtag: null, starsStale: false } as unknown as CatalogBundle;
    store.getState().actions.setBundle(bundle);
    expect(store.getState().bundle).toBe(bundle);
    store.getState().actions.setBundle(null);
    expect(store.getState().bundle).toBeNull();
  });

  it('numbers centre requests and clears only the one that was served', () => {
    const store = createSkyStore({}, T0);
    const { actions } = store.getState();
    actions.requestCentre('moon');
    expect(store.getState().centreRequest).toEqual({ id: 'moon', seq: 1 });
    actions.requestCentre('mars');
    expect(store.getState().centreRequest).toEqual({ id: 'mars', seq: 2 });
    // A stale acknowledgement leaves the newer request in place.
    actions.clearCentre(1);
    expect(store.getState().centreRequest).toEqual({ id: 'mars', seq: 2 });
    actions.clearCentre(2);
    expect(store.getState().centreRequest).toBeNull();
    const cleared = store.getState();
    actions.clearCentre(2);
    expect(store.getState()).toBe(cleared);
    // The sequence keeps growing after a clear.
    actions.requestCentre('hip:11767');
    expect(store.getState().centreRequest).toEqual({ id: 'hip:11767', seq: 3 });
  });

  it('retryNow increments the boot retry sequence and nothing else', () => {
    const store = createSkyStore({}, T0);
    const before = store.getState().boot;
    store.getState().actions.retryNow();
    expect(store.getState().boot).toEqual({ ...before, retrySeq: 1 });
    store.getState().actions.retryNow();
    expect(store.getState().boot.retrySeq).toBe(2);
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

  it('applies the night brightness through the options', () => {
    const store = createSkyStore({}, T0);
    const { actions } = store.getState();
    actions.applyUrl({ night: true, nightLevel: 0.6 }, T0);
    expect(store.getState().options).toMatchObject({ night: true, nightLevel: 0.6 });
    // `night=1` restores the full brightness, `night=0` keeps the level for the next toggle.
    actions.applyUrl({ night: true }, T0);
    expect(store.getState().options).toMatchObject({ night: true, nightLevel: 1 });
    actions.setNightLevel(0.4);
    actions.applyUrl({ night: false }, T0);
    expect(store.getState().options).toMatchObject({ night: false, nightLevel: 0.4 });
    // A level alone (never produced by the codec) is applied as such.
    actions.applyUrl({ nightLevel: 0.5 }, T0);
    expect(store.getState().options).toMatchObject({ night: false, nightLevel: 0.5 });
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

  it('writes the night brightness only while night is on below full brightness', () => {
    const store = createSkyStore({}, T0);
    const { actions } = store.getState();
    expect(urlStateOf(store.getState())).not.toHaveProperty('nightLevel');
    actions.setNightLevel(0.6);
    expect(urlStateOf(store.getState())).toMatchObject({ night: false });
    expect(urlStateOf(store.getState())).not.toHaveProperty('nightLevel');
    actions.setOptions({ night: true });
    expect(urlStateOf(store.getState())).toMatchObject({ night: true, nightLevel: 0.6 });
    expect(serializeUrlState(urlStateOf(store.getState()), defaultsUrlState())).toContain(
      '&night=0.6',
    );
    actions.setNightLevel(1);
    expect(urlStateOf(store.getState())).toMatchObject({ night: true });
    expect(urlStateOf(store.getState())).not.toHaveProperty('nightLevel');
    expect(serializeUrlState(urlStateOf(store.getState()), defaultsUrlState())).toContain(
      '&night=1',
    );
  });

  it('omits the observer while a geolocation prompt is up', () => {
    const store = createSkyStore({}, T0);
    const { actions } = store.getState();
    actions.setGeo('prompting');
    const url = urlStateOf(store.getState());
    expect(url).not.toHaveProperty('body');
    expect(url).not.toHaveProperty('lat');
    expect(url).not.toHaveProperty('lon');
    expect(url).not.toHaveProperty('elev');
    expect(url).toMatchObject({ t: 'live', az: 0, alt: 20, fov: 60 });
    expect(serializeUrlState(url, defaultsUrlState())).toBe('t=live&az=0&alt=20&fov=60');
    actions.setGeo('granted');
    expect(urlStateOf(store.getState())).toMatchObject({
      body: 'earth',
      lat: 51.48,
      lon: 0,
      elev: 0,
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
      layers: ['stars', 'planets', 'dso', 'clines', 'horizon'],
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

describe('augmented reality slice (plan D115)', () => {
  it('starts off with the default slice, which never reaches the URL', () => {
    const store = createSkyStore({}, T0);
    expect(store.getState().ar).toEqual(createArState());
    expect(store.getState().ar.cameraFovDeg).toBe(73);
    const before = urlStateOf(store.getState());
    const { actions } = store.getState();
    actions.setArCapabilities({
      secure: true,
      camera: true,
      orientation: true,
      touch: true,
      videoInput: true,
    });
    actions.setArPermission('granted');
    actions.requestAr();
    actions.setArMode('sensor');
    actions.setArOffset(12);
    actions.setArCameraFov(80);
    actions.setArHeading({ source: 'absolute', accuracyDeg: null, level: 'good' });
    actions.setArFrame({ width: 1280, height: 720 });
    actions.setArXr({ support: 'supported', phase: 'entering' });
    actions.dismissArHint();
    expect(store.getState().ar.mode).toBe('sensor');
    // `urlStateOf` picks explicit fields: nothing of the slice leaks (backlog B-73).
    expect(urlStateOf(store.getState())).toEqual(before);
    expect(serializeUrlState(urlStateOf(store.getState()), defaultsUrlState())).not.toMatch(
      /(^|&)ar/,
    );
    expect(Object.keys(urlStateOf(store.getState()))).not.toContain('ar');
  });

  it('requestAr enters from off only: remembers the view, ends follow, collapses the sheet, closes the dialog and clears the error', () => {
    const store = createSkyStore({ az: 123, alt: 10, fov: 45 }, T0);
    const { actions } = store.getState();
    actions.select('moon');
    actions.setFollow(true);
    actions.openPanel('time');
    actions.openDialog('about');
    actions.failAr('cameraDenied');
    expect(store.getState().ar.error).toBe('cameraDenied');
    const before = store.getState();

    actions.requestAr();
    const after = store.getState();
    expect(after.ar.mode).toBe('requesting');
    expect(after.ar.viewBefore).toEqual({ az: 123, alt: 10, fov: 45 });
    expect(after.ar.error).toBeNull();
    expect(after.follow).toBe(false);
    expect(after.ui).toMatchObject({ panel: 'time', sheet: 'collapsed', dialog: null });
    expect(after.selection).toBe('moon');
    expect(after.view).toBe(before.view);

    // Not from any other mode: the slice object is untouched.
    actions.setView({ az: 200 });
    actions.requestAr();
    expect(store.getState().ar).toBe(after.ar);
    actions.setArMode('sensor');
    const sensor = store.getState().ar;
    actions.requestAr();
    expect(store.getState().ar).toBe(sensor);
  });

  it('requestAr is a no-op off Earth (AR-1 is Earth only)', () => {
    const store = createSkyStore({}, T0);
    const { actions } = store.getState();
    actions.setObserver({ body: 'mars', lat: 0, lon: 0, elev: 0 });
    actions.select('moon');
    actions.setFollow(true);
    actions.openDialog('about');
    const before = store.getState();
    actions.requestAr();
    expect(store.getState()).toBe(before);
    expect(before.ar.mode).toBe('off');
    expect(before.follow).toBe(true);
    expect(before.ui.dialog).toBe('about');

    // Back on Earth the tap works again.
    actions.setObserver({ body: 'earth', lat: 51.48, lon: 0, elev: 0 });
    actions.requestAr();
    expect(store.getState().ar.mode).toBe('requesting');
    expect(store.getState().follow).toBe(false);
  });

  it('setArMode allows requesting -> sensor and sensor <-> xr only', () => {
    const store = createSkyStore({}, T0);
    const { actions } = store.getState();
    const off = store.getState().ar;
    actions.setArMode('sensor');
    actions.setArMode('xr');
    expect(store.getState().ar).toBe(off);

    actions.requestAr();
    actions.setArMode('xr');
    expect(store.getState().ar.mode).toBe('requesting');
    actions.setArMode('sensor');
    expect(store.getState().ar.mode).toBe('sensor');
    const sensor = store.getState().ar;
    actions.setArMode('sensor');
    expect(store.getState().ar).toBe(sensor);
    actions.setArMode('xr');
    expect(store.getState().ar.mode).toBe('xr');
    const xr = store.getState().ar;
    actions.setArMode('xr');
    expect(store.getState().ar).toBe(xr);
    actions.setArMode('sensor');
    expect(store.getState().ar.mode).toBe('sensor');
  });

  it('setArPose writes the canonical view and the roll in one set, and is a no-op while off', () => {
    const store = createSkyStore({ az: 0, alt: 20, fov: 60 }, T0);
    const { actions } = store.getState();
    let writes = 0;
    const stop = store.subscribe(() => {
      writes += 1;
    });
    actions.setArPose(90, 10, 5);
    expect(writes).toBe(0);
    expect(store.getState().view).toEqual({ az: 0, alt: 20, fov: 60 });
    expect(store.getState().ar.roll).toBe(0);

    actions.requestAr();
    writes = 0;
    actions.setArPose(370, 95, -12.5);
    expect(writes).toBe(1);
    expect(store.getState().view).toEqual({ az: 10, alt: 89.99, fov: 60 });
    expect(store.getState().ar.roll).toBe(-12.5);
    actions.setArMode('sensor');
    actions.setArPose(-90, -10, 170);
    expect(store.getState().view).toEqual({ az: 270, alt: -10, fov: 60 });
    expect(store.getState().ar.roll).toBe(170);
    stop();
  });

  it('exitAr restores the field of view, keeps the direction, resets the per-frame fields and keeps the error', () => {
    const store = createSkyStore({ az: 0, alt: 20, fov: 60 }, T0);
    const { actions } = store.getState();
    const off = store.getState().ar;
    actions.exitAr();
    expect(store.getState().ar).toBe(off);

    actions.requestAr();
    actions.setArMode('sensor');
    actions.setArPose(45, 30, 15);
    actions.setView({ fov: 40 });
    actions.setArFrame({ width: 640, height: 480 });
    actions.setArHeading({ source: 'compass', accuracyDeg: 12, level: 'good' });
    actions.setArXr({ support: 'supported', phase: 'active', aligned: true });
    actions.setArOffset(-20);
    actions.setArCameraFov(90);
    actions.setArPermission('granted');
    actions.exitAr();
    const { ar, view } = store.getState();
    expect(view).toEqual({ az: 45, alt: 30, fov: 60 });
    expect(ar).toMatchObject({
      mode: 'off',
      viewBefore: null,
      roll: 0,
      frame: null,
      heading: { source: 'none', accuracyDeg: null, level: 'none' },
      xr: { support: 'supported', phase: 'idle', aligned: null },
      error: null,
      // Calibration, camera field and permission survive the exit for the next entry.
      azOffsetDeg: -20,
      cameraFovDeg: 90,
      permission: 'granted',
    });
    // The error survives `exitAr` (the banner's dismiss clears it) and no `viewBefore` means the
    // field of view is left alone.
    actions.requestAr();
    actions.failAr('trackEnded');
    expect(store.getState().ar.error).toBe('trackEnded');
    actions.requestAr();
    expect(store.getState().ar.error).toBeNull();
    actions.exitAr();
    actions.failAr('noCamera');
    expect(store.getState().ar.error).toBe('noCamera');
    actions.exitAr();
    expect(store.getState().ar.error).toBe('noCamera');
  });

  it('failAr exits with the error; an xr code from sensor or xr keeps the sensor mode', () => {
    const store = createSkyStore({ az: 0, alt: 20, fov: 60 }, T0);
    const { actions } = store.getState();
    actions.requestAr();
    actions.setArMode('sensor');
    actions.setArPose(10, 10, 3);
    actions.setView({ fov: 30 });
    actions.setArXr({ support: 'supported', phase: 'entering', aligned: false });

    actions.failAr('xrUnsupported');
    expect(store.getState().ar).toMatchObject({
      mode: 'sensor',
      error: 'xrUnsupported',
      roll: 3,
      xr: { support: 'supported', phase: 'idle', aligned: null },
    });
    expect(store.getState().view.fov).toBe(30);

    actions.setArMode('xr');
    actions.setArXr({ phase: 'active', aligned: true });
    actions.failAr('xrFailed');
    expect(store.getState().ar).toMatchObject({
      mode: 'sensor',
      error: 'xrFailed',
      xr: { support: 'supported', phase: 'idle', aligned: null },
    });
    expect(store.getState().view.fov).toBe(30);

    // A sensor failure ends AR altogether, field of view restored.
    actions.failAr('orientationUnavailable');
    expect(store.getState().ar).toMatchObject({
      mode: 'off',
      error: 'orientationUnavailable',
      roll: 0,
      viewBefore: null,
    });
    expect(store.getState().view).toEqual({ az: 10, alt: 10, fov: 60 });

    // An xr code while requesting (no session possible yet) is a full exit as well.
    actions.requestAr();
    actions.failAr('xrDenied');
    expect(store.getState().ar).toMatchObject({ mode: 'off', error: 'xrDenied' });
    // And while off it only records the error.
    const view = store.getState().view;
    actions.failAr('xrBusy');
    expect(store.getState().ar).toMatchObject({ mode: 'off', error: 'xrBusy' });
    expect(store.getState().view).toBe(view);
    actions.clearArError();
    expect(store.getState().ar.error).toBeNull();
    const cleared = store.getState().ar;
    actions.clearArError();
    expect(store.getState().ar).toBe(cleared);
  });

  it('wraps the calibration offset to [-180, 180) and clamps the camera field', () => {
    const store = createSkyStore({}, T0);
    const { actions } = store.getState();
    actions.setArOffset(190);
    expect(store.getState().ar.azOffsetDeg).toBe(-170);
    actions.setArOffset(-180);
    expect(store.getState().ar.azOffsetDeg).toBe(-180);
    actions.setArOffset(180);
    expect(store.getState().ar.azOffsetDeg).toBe(-180);
    actions.setArOffset(0);
    expect(store.getState().ar.azOffsetDeg).toBe(0);
    actions.nudgeArOffset(170);
    actions.nudgeArOffset(20);
    expect(store.getState().ar.azOffsetDeg).toBe(-170);
    actions.nudgeArOffset(-15);
    expect(store.getState().ar.azOffsetDeg).toBe(175);
    const ar = store.getState().ar;
    actions.setArOffset(NaN);
    actions.nudgeArOffset(Infinity);
    expect(store.getState().ar).toBe(ar);

    actions.setArCameraFov(20);
    expect(store.getState().ar.cameraFovDeg).toBe(50);
    actions.setArCameraFov(200);
    expect(store.getState().ar.cameraFovDeg).toBe(110);
    actions.setArCameraFov(77.5);
    expect(store.getState().ar.cameraFovDeg).toBe(77.5);
    actions.setArCameraFov(NaN);
    expect(store.getState().ar.cameraFovDeg).toBe(73);
  });

  it('updates the permission, heading, frame, XR patch, capabilities and hint', () => {
    const store = createSkyStore({}, T0);
    const { actions } = store.getState();
    const initial = store.getState();
    actions.setArPermission('pending');
    expect(store.getState().ar.permission).toBe('pending');
    actions.setArHeading({ source: 'compass', accuracyDeg: 25, level: 'fair' });
    expect(store.getState().ar.heading).toEqual({
      source: 'compass',
      accuracyDeg: 25,
      level: 'fair',
    });
    actions.setArFrame({ width: 1920, height: 1080 });
    expect(store.getState().ar.frame).toEqual({ width: 1920, height: 1080 });
    actions.setArFrame(null);
    expect(store.getState().ar.frame).toBeNull();
    actions.setArXr({ support: 'unsupported' });
    expect(store.getState().ar.xr).toEqual({
      support: 'unsupported',
      phase: 'idle',
      aligned: null,
    });
    actions.setArXr({ phase: 'exiting', aligned: false });
    expect(store.getState().ar.xr).toEqual({
      support: 'unsupported',
      phase: 'exiting',
      aligned: false,
    });
    const caps = { secure: true, camera: false, orientation: true, touch: true, videoInput: false };
    actions.setArCapabilities(caps);
    expect(store.getState().ar.capabilities).toBe(caps);
    actions.dismissArHint();
    expect(store.getState().ar.hintDismissed).toBe(true);
    // Nothing else moved.
    expect(store.getState().view).toBe(initial.view);
    expect(store.getState().ui).toBe(initial.ui);
    expect(store.getState().clock).toBe(initial.clock);
  });

  it('leaving Earth exits AR through setObserver and applyUrl (AR-1)', () => {
    const store = createSkyStore({ az: 0, alt: 20, fov: 60 }, T0);
    const { actions } = store.getState();
    actions.requestAr();
    actions.setArMode('sensor');
    actions.setArPose(100, 5, 8);
    actions.setView({ fov: 35 });
    // A move on Earth keeps AR running.
    actions.setObserver({ body: 'earth', lat: 48.85, lon: 2.35, elev: 35 });
    expect(store.getState().ar.mode).toBe('sensor');
    let writes = 0;
    const stop = store.subscribe(() => {
      writes += 1;
    });
    actions.setObserver({ body: 'mars', lat: 0, lon: 0, elev: 0 });
    expect(writes).toBe(1);
    expect(store.getState().observer.body).toBe('mars');
    expect(store.getState().ar).toMatchObject({ mode: 'off', roll: 0, viewBefore: null });
    expect(store.getState().view).toEqual({ az: 100, alt: 5, fov: 60 });
    stop();

    // Back on Earth, in AR again; a URL to the Moon exits in the same write and keeps its fov.
    actions.setObserver({ body: 'earth', lat: 51.48, lon: 0, elev: 0 });
    actions.requestAr();
    actions.setArMode('sensor');
    actions.setView({ fov: 35 });
    actions.applyUrl({ body: 'moon', fov: 25 }, T0);
    expect(store.getState().observer.body).toBe('moon');
    expect(store.getState().ar.mode).toBe('off');
    expect(store.getState().view.fov).toBe(25);
    // Without a URL fov the entry value returns.
    actions.setObserver({ body: 'earth', lat: 51.48, lon: 0, elev: 0 });
    actions.requestAr();
    actions.setView({ fov: 35 });
    actions.applyUrl({ body: 'mars', az: 10 }, T0);
    expect(store.getState().ar.mode).toBe('off');
    // az from the URL, alt as the last pose left it, fov as it was at this entry.
    expect(store.getState().view).toEqual({ az: 10, alt: 5, fov: 25 });
    // A URL that stays on Earth or names no body leaves AR alone.
    actions.setObserver({ body: 'earth', lat: 51.48, lon: 0, elev: 0 });
    actions.requestAr();
    actions.applyUrl({ lat: 40, body: 'earth' }, T0);
    actions.applyUrl({ az: 20 }, T0);
    expect(store.getState().ar.mode).toBe('requesting');
  });
});

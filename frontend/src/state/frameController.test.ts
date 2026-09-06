// @vitest-environment node
// Frame controller (plan D76, brief l.67-70, l.281): a fake fetcher and clock drive the first
// fetch, prefetch and swap, cancellation of a superseded request, the 422 / 503 / network error
// policies and `whenCovering`.

import { ApiProblem, NetworkError } from '../api/client';
import type { FrameResponse, MetaResponse } from '../api/client';
import { DAY_MS, DAY_S } from '../sky/math/time';
import {
  BLOCKING_RETRY_AFTER_S,
  DECIDE_INTERVAL_MS,
  createFrameController,
} from './frameController';
import type { FrameFetcher } from './frameController';
import { COVERAGE_GUARD_D, requestKey, shapeKey } from './frames';
import type { FrameQuery } from './frames';
import { createSkyStore } from './store';
import type { SkyStore } from './storeTypes';
import { createFrameEval } from './types';

const T0 = 1_757_000_000_000;
const TT = 2460409.3123456;
const TT_MINUS_UTC = 69.2;
const PROBLEM = 'https://github.com/j-about/InterSidera/blob/master/docs/api.md#problem-';

const BODIES: MetaResponse['bodies'] = (
  [
    ['sun', 'star', 'sun_and_outer'],
    ['mercury', 'planet', 'inner_planets'],
    ['venus', 'planet', 'inner_planets'],
    ['earth', 'planet', 'sun_and_outer'],
    ['moon', 'moon', 'moon'],
    ['mars', 'planet', 'inner_planets'],
    ['jupiter', 'planet', 'sun_and_outer'],
    ['saturn', 'planet', 'sun_and_outer'],
    ['uranus', 'planet', 'sun_and_outer'],
    ['neptune', 'planet', 'sun_and_outer'],
    ['pluto', 'dwarf_planet', 'sun_and_outer'],
  ] as const
).map(([id, kind, step_class]) => ({
  id,
  kind,
  name_key: `bodies.${id}`,
  radius_km: 1,
  step_class,
}));

function makeMeta(bodies: MetaResponse['bodies'] = BODIES): MetaResponse {
  return {
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
    bodies,
    catalogs: {
      stars: {
        count: 0,
        version: '1',
        etag: 'stars-etag',
        epoch_tt: 2451545,
        magnitude_limit: 13.9,
        license: 'CC-BY-4.0',
        attribution: 'ESA Hipparcos',
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
}

function syntheticResponse(request: FrameQuery): FrameResponse {
  const n = request.n ?? 32;
  const rows = <T>(f: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => f(i));
  return {
    observer: {
      body: request.body ?? 'earth',
      lat_deg: request.lat,
      lon_deg: request.lon,
      elev_m: request.elev ?? 0,
      latitude_kind: 'geodetic',
      warnings: [],
    },
    time: {
      tt0: request.tt,
      step_s: request.step_s ?? 60,
      n,
      tt_minus_utc_seconds: TT_MINUS_UTC,
      utc0: '2024-04-08T17:58:50Z',
      warnings: [{ code: 'proper_motion_extrapolated', params: { years: 10000 } }],
    },
    horizon: { q: rows(() => [0, 0, 0, 1]) },
    equinox_of_date: { q: rows(() => [0, 0, 0, 1]) },
    observer_velocity_au_d: rows(() => [0, 0.017, 0]),
    sun_dir: rows(() => [1, 0, 0]),
    bodies: BODIES.filter((b) => b.id !== (request.body ?? 'earth')).map((b) => ({
      id: b.id,
      kind: b.kind,
      samples: {
        dir: rows(() => [0, 1, 0]),
        dist_au: rows(() => 1),
        mag: rows(() => 0),
        phase: rows(() => 1),
        diam_deg: rows(() => 0.01),
      },
      warnings: [],
    })),
    minor: [],
  };
}

interface Call {
  query: FrameQuery;
  signal: AbortSignal;
  resolve: (response: FrameResponse) => void;
  reject: (error: unknown) => void;
}

/** A fetcher that records every call and lets the test settle each one by hand. */
function fakeFetcher(options: { rejectOnAbort?: boolean } = {}): {
  calls: Call[];
  fetcher: FrameFetcher;
} {
  const calls: Call[] = [];
  const fetcher: FrameFetcher = (query, signal) =>
    new Promise<FrameResponse>((resolve, reject) => {
      calls.push({ query, signal, resolve, reject });
      if (options.rejectOnAbort !== false) {
        signal.addEventListener(
          'abort',
          () => {
            reject(new DOMException('The user aborted a request.', 'AbortError'));
          },
          { once: true },
        );
      }
    });
  return { calls, fetcher };
}

function call(calls: Call[], i: number): Call {
  const c = calls[i];
  if (c === undefined) {
    throw new Error(`fetch call ${String(i)} missing`);
  }
  return c;
}

/** Let every settled promise callback run. */
function flush(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

function problem(
  status: number,
  slug: string,
  extra: Partial<ConstructorParameters<typeof ApiProblem>[0]> = {},
): ApiProblem {
  return new ApiProblem({
    status,
    slug: slug as ApiProblem['slug'],
    type: `${PROBLEM}${slug}`,
    title: `Problem ${slug}`,
    ...extra,
  });
}

interface Harness {
  store: SkyStore;
  calls: Call[];
  controller: ReturnType<typeof createFrameController>;
  clock: { ms: number };
  onError: ReturnType<typeof vi.fn>;
}

function harness(
  url: { t?: 'live' | number; speed?: number } = { t: TT },
  meta = makeMeta(),
): Harness {
  const store = createSkyStore(url, T0);
  store.getState().actions.setMeta(meta);
  const { calls, fetcher } = fakeFetcher();
  const clock = { ms: T0 };
  const onError = vi.fn();
  const controller = createFrameController({
    store,
    fetchFrame: fetcher,
    now: () => clock.ms,
    onError,
    random: () => 1,
  });
  return { store, calls, controller, clock, onError };
}

/** Advance the fake clock past the decide throttle and run the policy at `tt`. */
function tick(h: Harness, tt: number, ms = DECIDE_INTERVAL_MS): void {
  h.clock.ms += ms;
  h.controller.update(tt, h.clock.ms);
}

describe('createFrameController', () => {
  it('does nothing before /meta and issues the first request from the store afterwards', async () => {
    const store = createSkyStore({ t: TT }, T0);
    const { calls, fetcher } = fakeFetcher();
    const controller = createFrameController({ store, fetchFrame: fetcher, now: () => T0 });
    controller.update(TT, T0);
    expect(calls).toHaveLength(0);
    const out = createFrameEval(16);
    controller.evaluate(TT, out);
    expect(out.valid).toBe(false);

    store.getState().actions.setMeta(makeMeta());
    controller.update(TT, T0);
    expect(calls).toHaveLength(1);
    const { query } = call(calls, 0);
    // Paused at Greenwich: 1 s steps, 32 samples, the observer rounded (OBS-7), no minor.
    expect(query).toMatchObject({
      body: 'earth',
      lat: 51.48,
      lon: 0,
      elev: 0,
      step_s: 1,
      n: 32,
      bodies: 'all',
    });
    expect(query).not.toHaveProperty('minor');
    expect(controller.state.inFlight?.key).toBe(requestKey(query));
    expect(store.getState().frames.status).toBe('loading');

    call(calls, 0).resolve(syntheticResponse(query));
    await flush();
    expect(controller.state.inFlight).toBeNull();
    expect(controller.state.current?.key).toBe(requestKey(query));
    expect(store.getState().frames).toEqual({
      status: 'ready',
      lastError: null,
      window: {
        tt0: query.tt,
        stepS: 1,
        n: 32,
        bodies: BODIES.filter((b) => b.id !== 'earth').map((b) => b.id),
      },
      snapshot: false,
      extrapolating: false,
      warnings: [{ code: 'proper_motion_extrapolated', params: { years: 10000 } }],
    });
    expect(store.getState().clock.ttMinusUtc).toBe(TT_MINUS_UTC);
    controller.evaluate(TT, out);
    expect(out.valid).toBe(true);
    expect(out.bodyCount).toBe(10);
    // Nothing more to do on the next ticks.
    controller.update(TT, T0 + 1000);
    expect(calls).toHaveLength(1);
    controller.dispose();
  });

  it('prefetches at 70 % and swaps to the next window when tt enters it', async () => {
    const h = harness({ t: TT, speed: 60 });
    h.controller.update(TT, T0);
    call(h.calls, 0).resolve(syntheticResponse(call(h.calls, 0).query));
    await flush();
    const current = h.controller.state.current;
    if (current === null) {
      throw new Error('no current window');
    }
    const span = (current.n - 1) * current.stepD;
    expect(current.stepD * DAY_S).toBeCloseTo(113, 9);

    tick(h, current.tt0 + 0.5 * span);
    expect(h.calls).toHaveLength(1);
    tick(h, current.tt0 + 0.72 * span);
    expect(h.calls).toHaveLength(2);
    const prefetch = call(h.calls, 1).query;
    expect(prefetch.tt).toBeCloseTo(current.ttEnd, 12);
    expect(prefetch.n).toBe(32);
    call(h.calls, 1).resolve(syntheticResponse(prefetch));
    await flush();
    expect(h.controller.state.next?.tt0).toBeCloseTo(current.ttEnd, 12);
    expect(h.controller.state.current).toBe(current);
    expect(h.store.getState().frames.window?.tt0).toBe(current.tt0);

    // Before the swap, evaluation already uses next once tt is inside it.
    const out = createFrameEval(16);
    h.controller.evaluate(current.ttEnd + 0.5 * current.stepD, out);
    expect(out.valid).toBe(true);
    expect(out.extrapolating).toBe(false);

    tick(h, current.ttEnd + 2 * current.stepD);
    expect(h.controller.state.current?.tt0).toBeCloseTo(current.ttEnd, 12);
    expect(h.controller.state.next).toBeNull();
    expect(h.store.getState().frames.window?.tt0).toBeCloseTo(current.ttEnd, 12);
    expect(h.calls).toHaveLength(2);
    h.controller.dispose();
  });

  it('cancels an in-flight request when the observer changes and ignores a late response', async () => {
    const store = createSkyStore({ t: TT }, T0);
    store.getState().actions.setMeta(makeMeta());
    // This fetcher does not honour the abort: the late resolution must still be ignored.
    const { calls, fetcher } = fakeFetcher({ rejectOnAbort: false });
    const controller = createFrameController({ store, fetchFrame: fetcher, now: () => T0 });
    controller.update(TT, T0);
    expect(calls).toHaveLength(1);

    store.getState().actions.setObserver({ body: 'earth', lat: 40, lon: -3.7, elev: 650 });
    controller.update(TT, T0 + 1); // a store change runs the policy without waiting the throttle
    expect(calls).toHaveLength(2);
    expect(call(calls, 0).signal.aborted).toBe(true);
    expect(call(calls, 1).signal.aborted).toBe(false);
    expect(call(calls, 1).query).toMatchObject({ lat: 40, lon: -3.7, elev: 650 });

    call(calls, 0).resolve(syntheticResponse(call(calls, 0).query));
    await flush();
    expect(controller.state.current).toBeNull();
    call(calls, 1).resolve(syntheticResponse(call(calls, 1).query));
    await flush();
    expect(controller.state.current?.request.lat).toBe(40);
    controller.dispose();
  });

  it('pauses one guard inside the bound on a 422 outside-coverage and refetches flush with it', async () => {
    const h = harness({ t: TT, speed: 60 });
    h.controller.update(TT, T0);
    const first = call(h.calls, 0).query;
    const end = 2450000.5;
    call(h.calls, 0).reject(problem(422, 'outside-coverage', { rangeTt: [2400000.5, end] }));
    await flush();
    const state = h.store.getState();
    expect(state.clock.mode).toBe('paused');
    expect(state.clock.speed).toBe(0);
    // The time itself lies beyond `range_tt`: the clock stops one guard inside the bound (plan
    // D76; the bound itself is not requestable after the API's 1e-8 day rounding).
    expect(state.clock.tt).toBe(end - COVERAGE_GUARD_D);
    expect(h.onError).toHaveBeenCalledTimes(1);
    // The same shape is refetched at once, ending half a guard inside the bound and covering
    // the stopped clock, so a cold start at the bound renders the sky there (TIME-4).
    expect(h.calls).toHaveLength(2);
    const bound = call(h.calls, 1).query;
    const span = (((bound.n ?? 32) - 1) * (bound.step_s ?? 60)) / DAY_S;
    expect(bound).toEqual({ ...first, tt: bound.tt });
    expect(bound.tt + span).toBeCloseTo(end - COVERAGE_GUARD_D / 2, 9);
    expect(bound.tt).toBeLessThanOrEqual(state.clock.tt);
    expect(state.frames.status).toBe('loading');
    expect(state.frames.lastError).toBeNull();
    expect(h.controller.state.failedKey).toBeNull();
    let covered = false;
    void h.controller.whenCovering(state.clock.tt).then(() => {
      covered = true;
    });
    call(h.calls, 1).resolve(syntheticResponse(bound));
    await flush();
    expect(covered).toBe(true);
    expect(h.store.getState().frames.status).toBe('ready');
    // Paused at the bound the window covers the time: nothing more is asked for.
    tick(h, state.clock.tt, 1000);
    tick(h, state.clock.tt, 1000);
    expect(h.calls).toHaveLength(2);
    expect(h.store.getState().frames.extrapolating).toBe(false);
    h.controller.dispose();
  });

  it('blocks the paused shape when the refetch at the bound is refused too, until the time changes', async () => {
    const h = harness({ t: TT, speed: 60 });
    h.controller.update(TT, T0);
    const range: [number, number] = [2400000.5, 2450000.5];
    call(h.calls, 0).reject(problem(422, 'outside-coverage', { rangeTt: range }));
    await flush();
    expect(h.calls).toHaveLength(2);
    call(h.calls, 1).reject(problem(422, 'outside-coverage', { rangeTt: range }));
    await flush();
    const state = h.store.getState();
    expect(state.clock.mode).toBe('paused');
    expect(state.clock.tt).toBe(range[1] - COVERAGE_GUARD_D);
    expect(state.frames.status).toBe('error');
    expect(state.frames.lastError).toEqual({ status: 422, blocked: true });
    expect(h.controller.state.failedKey).not.toBeNull();
    expect(h.onError).toHaveBeenCalledTimes(2);
    // The paused simulation produces the blocked shape: no request until the time changes.
    tick(h, state.clock.tt, 1000);
    tick(h, state.clock.tt, 1000);
    expect(h.calls).toHaveLength(2);
    h.store.getState().actions.setTime(TT - 100, h.clock.ms);
    h.controller.update(TT - 100, h.clock.ms);
    expect(h.calls).toHaveLength(3);
    // Without `range_tt` there is no bound to aim at: the paused shape is blocked at once.
    call(h.calls, 2).reject(problem(422, 'outside-coverage'));
    await flush();
    expect(h.calls).toHaveLength(3);
    expect(h.store.getState().clock.tt).toBe(TT - 100);
    expect(h.store.getState().frames.lastError).toEqual({ status: 422, blocked: true });
    tick(h, TT - 100, 1000);
    expect(h.calls).toHaveLength(3);
    h.controller.dispose();
  });

  it('keeps playing after a 422 on a prefetch, blocks that shape only and stops at the seam', async () => {
    const h = harness({ t: TT, speed: 60 });
    h.controller.update(TT, T0);
    call(h.calls, 0).resolve(syntheticResponse(call(h.calls, 0).query));
    await flush();
    const current = h.controller.state.current;
    if (current === null) {
      throw new Error('no current window');
    }
    const span = (current.n - 1) * current.stepD;
    tick(h, current.tt0 + 0.72 * span);
    expect(h.calls).toHaveLength(2);
    const prefetch = call(h.calls, 1).query;
    // The coverage ends a few samples into the continuation: `current` is entirely valid.
    const bound = current.ttEnd + 4.5 * current.stepD;
    call(h.calls, 1).reject(problem(422, 'outside-coverage', { rangeTt: [2400000.5, bound] }));
    await flush();
    expect(h.store.getState().clock.mode).toBe('playing');
    expect(h.store.getState().frames.status).toBe('ready');
    expect(h.controller.state.failedKey).toBe(requestKey(prefetch));
    expect(h.onError).toHaveBeenCalledTimes(1);
    // Exactly one request for that continuation: no new prefetch on the following ticks.
    tick(h, current.tt0 + 0.75 * span);
    tick(h, current.tt0 + 0.8 * span);
    tick(h, current.tt0 + 0.95 * span);
    expect(h.calls).toHaveLength(2);

    // Past the seam the refetch at `tt` fails the same way: the clock stops where it is (the
    // time lies inside `range_tt`, only the window leaves it) and the paused shape is blocked.
    const jumpTt = current.ttEnd + 2.5 * current.stepD;
    h.store.getState().actions.setTime(jumpTt, h.clock.ms);
    h.store.getState().actions.play(60, h.clock.ms);
    tick(h, jumpTt);
    expect(h.calls).toHaveLength(3);
    expect(call(h.calls, 2).query.tt).toBeCloseTo(current.ttEnd + current.stepD, 9);
    call(h.calls, 2).reject(problem(422, 'outside-coverage', { rangeTt: [2400000.5, bound] }));
    await flush();
    const state = h.store.getState();
    expect(state.clock.mode).toBe('paused');
    expect(state.clock.tt).toBeGreaterThanOrEqual(jumpTt);
    expect(state.clock.tt).toBeLessThan(bound);
    expect(state.frames.status).toBe('ready');
    expect(h.onError).toHaveBeenCalledTimes(2);
    // The same shape is refetched flush with the bound for the stopped clock, then nothing more.
    expect(h.calls).toHaveLength(4);
    const flushed = call(h.calls, 3).query;
    expect(flushed.step_s).toBe(call(h.calls, 2).query.step_s);
    expect(flushed.tt + 31 * current.stepD).toBeCloseTo(bound - COVERAGE_GUARD_D / 2, 9);
    expect(flushed.tt).toBeLessThanOrEqual(state.clock.tt);
    call(h.calls, 3).resolve(syntheticResponse(flushed));
    await flush();
    expect(h.controller.state.current?.tt0).toBe(flushed.tt);
    tick(h, state.clock.tt, 1000);
    tick(h, state.clock.tt, 1000);
    expect(h.calls).toHaveLength(4);
    h.controller.dispose();
  });

  it('remembers a 503 with a long Retry-After without retrying, until the shape changes', async () => {
    const h = harness();
    h.controller.update(TT, T0);
    const { query } = call(h.calls, 0);
    call(h.calls, 0).reject(problem(503, 'data-not-ready', { retryAfterS: 60 }));
    await flush();
    expect(h.controller.state.failedShape).toBe(shapeKey(query));
    expect(h.controller.state.failedKey).toBeNull();
    expect(h.store.getState().frames.status).toBe('error');
    for (let i = 0; i < 5; i += 1) {
      // The time moves on (a running clock would): the shape stays blocked.
      tick(h, TT + i / 24, 30_000);
    }
    expect(h.calls).toHaveLength(1);
    h.store.getState().actions.setObserver({ body: 'earth', lat: 40, lon: -3.7, elev: 650 });
    tick(h, TT);
    expect(h.calls).toHaveLength(2);

    // A 503 with a short Retry-After is a hiccup: it backs off for exactly that long.
    call(h.calls, 1).reject(
      problem(503, 'data-not-ready', { retryAfterS: BLOCKING_RETRY_AFTER_S - 25 }),
    );
    await flush();
    // The blocked shape stays blocked (only a success clears it); this one merely backs off.
    expect(h.controller.state.failedShape).toBe(shapeKey(query));
    tick(h, TT, 4_000);
    expect(h.calls).toHaveLength(2);
    tick(h, TT, 1_000);
    expect(h.calls).toHaveLength(3);
    h.controller.dispose();
  });

  it('backs off after a network error while evaluate keeps extrapolating', async () => {
    const h = harness({ t: TT, speed: 60 });
    h.controller.update(TT, T0);
    call(h.calls, 0).resolve(syntheticResponse(call(h.calls, 0).query));
    await flush();
    const current = h.controller.state.current;
    if (current === null) {
      throw new Error('no current window');
    }
    const span = (current.n - 1) * current.stepD;
    tick(h, current.tt0 + 0.75 * span);
    expect(h.calls).toHaveLength(2);
    call(h.calls, 1).reject(
      new NetworkError('/api/v1/sky/frame', new TypeError('Failed to fetch')),
    );
    await flush();
    expect(h.controller.state.inFlight).toBeNull();
    expect(h.onError).toHaveBeenCalledWith(expect.any(NetworkError));
    expect(h.store.getState().frames.status).toBe('ready');

    // Full jitter with random() = 1: 500 ms before the same prefetch is issued again.
    tick(h, current.tt0 + 0.8 * span, 200);
    tick(h, current.tt0 + 0.8 * span, 200);
    expect(h.calls).toHaveLength(2);
    tick(h, current.tt0 + 0.8 * span, 100);
    expect(h.calls).toHaveLength(3);

    // Meanwhile the picture never stalls: beyond the window the evaluation extrapolates.
    const out = createFrameEval(16);
    h.controller.evaluate(current.ttEnd + current.stepD, out);
    expect(out.valid).toBe(true);
    expect(out.extrapolating).toBe(true);
    tick(h, current.ttEnd + current.stepD);
    expect(h.store.getState().frames.extrapolating).toBe(true);

    // A second consecutive failure doubles the wait (1000 ms) and a malformed body counts too.
    const bad = syntheticResponse(call(h.calls, 2).query);
    bad.horizon.q = bad.horizon.q.slice(0, 3);
    call(h.calls, 2).resolve(bad);
    await flush();
    expect(h.onError).toHaveBeenLastCalledWith(expect.any(RangeError));
    expect(h.controller.state.next).toBeNull();
    h.controller.dispose();
  });

  it('starts the backoff ladder afresh for another request shape', async () => {
    const h = harness();
    h.controller.update(TT, T0);
    call(h.calls, 0).reject(new NetworkError('/api/v1/sky/frame', new TypeError('offline')));
    await flush();
    // Another shape (the observer moved) fails once: 500 ms, not the doubled 1000 ms.
    h.store.getState().actions.setObserver({ body: 'earth', lat: 40, lon: -3.7, elev: 650 });
    tick(h, TT);
    expect(h.calls).toHaveLength(2);
    call(h.calls, 1).reject(new NetworkError('/api/v1/sky/frame', new TypeError('offline')));
    await flush();
    tick(h, TT, 400);
    expect(h.calls).toHaveLength(2);
    tick(h, TT, 100);
    expect(h.calls).toHaveLength(3);
    expect(call(h.calls, 2).query).toMatchObject({ lat: 40, lon: -3.7 });
    h.controller.dispose();
  });

  it('keeps a slow first request alive across alignment buckets and grows the backoff on the shape', async () => {
    // Live mode: 2 s steps, so the exact key of the request the simulation would issue moves
    // every 2 s of wall time. A first request slower than that must not be cancelled.
    const h = harness({ t: 'live' });
    const ttNow = (): number => TT + (h.clock.ms - T0) / DAY_MS;
    h.controller.update(ttNow(), T0);
    expect(h.calls).toHaveLength(1);
    for (let k = 0; k < 40; k += 1) {
      tick(h, ttNow(), DECIDE_INTERVAL_MS + 5);
    }
    expect(h.calls).toHaveLength(1);
    expect(call(h.calls, 0).signal.aborted).toBe(false);
    expect(h.store.getState().frames.status).toBe('loading');

    // The API is down for 30 s and every request fails at once. With random() = 1 the ladder
    // waits 0.5, 1, 2, 4, 8 s (brief l.281): five requests, each wait double the previous one,
    // although the key of the shape changes every 2 s.
    const issuedAtMs: number[] = [];
    const rejected = new Set<number>();
    for (let ms = 0; ms < 30_000; ms += DECIDE_INTERVAL_MS + 5) {
      h.calls.forEach((c, i) => {
        if (!rejected.has(i)) {
          rejected.add(i);
          issuedAtMs.push(h.clock.ms);
          c.reject(new NetworkError('/api/v1/sky/frame', new TypeError('down')));
        }
      });
      await flush();
      tick(h, ttNow(), DECIDE_INTERVAL_MS + 5);
    }
    expect(h.calls).toHaveLength(6);
    expect(h.store.getState().frames.lastError).toEqual({ status: 0, blocked: false });
    issuedAtMs.forEach((at, i) => {
      if (i === 0) {
        return;
      }
      const previous = issuedAtMs[i - 1];
      if (previous === undefined) {
        throw new Error('unreachable');
      }
      const wait = 500 * 2 ** (i - 1);
      expect(at - previous).toBeGreaterThanOrEqual(wait);
      expect(at - previous).toBeLessThanOrEqual(wait + 2 * (DECIDE_INTERVAL_MS + 5));
    });
    h.controller.dispose();
  });

  it('treats a fetcher that aborts on its own as a transient failure', async () => {
    const h = harness();
    h.controller.update(TT, T0);
    // Not our abort (the signal is untouched): the request must not stay in flight forever.
    expect(call(h.calls, 0).signal.aborted).toBe(false);
    call(h.calls, 0).reject(new DOMException('The operation timed out.', 'AbortError'));
    await flush();
    expect(h.controller.state.inFlight).toBeNull();
    expect(h.onError).toHaveBeenCalledWith(expect.any(DOMException));
    tick(h, TT, 400);
    expect(h.calls).toHaveLength(1);
    tick(h, TT, 100);
    expect(h.calls).toHaveLength(2);
    h.controller.dispose();
  });

  it('resolves whenCovering once a loaded window covers the time', async () => {
    const h = harness();
    let coveredNow = false;
    let coveredLater = false;
    void h.controller.whenCovering().then(() => {
      coveredNow = true;
    });
    void h.controller.whenCovering(TT + 1).then(() => {
      coveredLater = true;
    });
    await flush();
    expect(coveredNow).toBe(false);

    h.controller.update(TT, T0);
    call(h.calls, 0).resolve(syntheticResponse(call(h.calls, 0).query));
    await flush();
    expect(coveredNow).toBe(true);
    expect(coveredLater).toBe(false);
    await expect(h.controller.whenCovering(TT)).resolves.toBeUndefined();

    h.store.getState().actions.setTime(TT + 1, h.clock.ms);
    tick(h, TT + 1);
    call(h.calls, 1).resolve(syntheticResponse(call(h.calls, 1).query));
    await flush();
    expect(coveredLater).toBe(true);
    h.controller.dispose();
  });

  it('runs snapshot mode at most every 250 ms and reports it', async () => {
    const h = harness({ t: TT, speed: 86400 });
    h.controller.update(TT, T0);
    const first = call(h.calls, 0).query;
    expect(first.n).toBe(1);
    call(h.calls, 0).resolve(syntheticResponse(first));
    await flush();
    expect(h.store.getState().frames.snapshot).toBe(true);
    expect(h.controller.state.lastSnapshotDoneMs).toBe(T0);
    const oneStep = 3600 / DAY_S;
    tick(h, TT + oneStep, 100);
    expect(h.calls).toHaveLength(1);
    tick(h, TT + 2 * oneStep, 200);
    expect(h.calls).toHaveLength(2);
    expect(call(h.calls, 1).query.n).toBe(1);
    h.controller.dispose();
  });

  it('throws on a step class absent from the limits and stops after dispose', () => {
    const bogus: MetaResponse['bodies'] = [
      ...BODIES,
      {
        id: 'vulcan',
        kind: 'planet',
        name_key: 'bodies.vulcan',
        radius_km: 1,
        step_class: 'bogus',
      },
    ];
    const broken = harness({ t: TT }, makeMeta(bogus));
    expect(() => {
      broken.controller.update(TT, T0);
    }).toThrow(RangeError);

    const h = harness();
    h.controller.update(TT, T0);
    expect(h.calls).toHaveLength(1);
    h.controller.dispose();
    expect(call(h.calls, 0).signal.aborted).toBe(true);
    expect(h.controller.state.inFlight).toBeNull();
    tick(h, TT + 1, 1000);
    expect(h.calls).toHaveLength(1);
  });
});

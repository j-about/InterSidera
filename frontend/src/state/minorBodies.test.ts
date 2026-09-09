// @vitest-environment node
// Minor-body defaults (SKY-4, plan D102): fetched once the layer is on and the MPC catalog is
// announced, one attempt per arming (layer toggle or retry), a 503 recorded as `missing`, an
// abort that leaves the store alone.

import { ApiProblem } from '../api/client';
import type { MetaResponse } from '../api/client';
import { startMinorBodies } from './minorBodies';
import { createSkyStore } from './store';
import type { MinorBodySummary } from './storeTypes';

const T0 = 1_757_000_000_000;

const META: MetaResponse = {
  api_version: '1.1.0',
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
      count: 0,
      version: '1',
      etag: 'stars-etag',
      epoch_tt: 2451545,
      magnitude_limit: 13.9,
      license: 'CC-BY-4.0',
      attribution: 'ESA Hipparcos',
    },
    minor_bodies: {
      asteroids: 1_400_000,
      comets: 1200,
      elements_epoch_range_tt: [2460000.5, 2461300.5],
      license: 'MPC',
      attribution: 'Minor Planet Center',
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

const DEFAULTS: MinorBodySummary[] = [
  {
    id: 'a:1',
    designation: '(1) Ceres',
    name: 'Ceres',
    kind: 'asteroid',
    elements_epoch_tt: 2461200.5,
  },
  { id: 'c:1P', designation: '1P/Halley', kind: 'comet', elements_epoch_tt: 2461200.5 },
];

function flush(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** A fetcher whose calls the test settles by hand. */
function fakeFetcher(): {
  calls: {
    signal: AbortSignal;
    resolve: (list: MinorBodySummary[]) => void;
    reject: (e: unknown) => void;
  }[];
  fetchDefaults: (signal: AbortSignal) => Promise<readonly MinorBodySummary[]>;
} {
  const calls: {
    signal: AbortSignal;
    resolve: (list: MinorBodySummary[]) => void;
    reject: (e: unknown) => void;
  }[] = [];
  return {
    calls,
    fetchDefaults: (signal) =>
      new Promise<readonly MinorBodySummary[]>((resolve, reject) => {
        calls.push({ signal, resolve, reject });
      }),
  };
}

describe('startMinorBodies', () => {
  it('fetches the defaults once the layer is on and the MPC catalog is announced', async () => {
    const store = createSkyStore({}, T0);
    const { calls, fetchDefaults } = fakeFetcher();
    const stop = startMinorBodies(store, { fetchDefaults });
    // Layer off, no meta: nothing.
    expect(calls).toHaveLength(0);
    store.getState().actions.setLayer('minor', true);
    // Layer on but /meta unknown yet: still nothing.
    expect(calls).toHaveLength(0);
    store.getState().actions.setMeta(META);
    expect(calls).toHaveLength(1);
    expect(store.getState().minorBodies).toEqual({ defaults: null, status: 'loading', shown: 20 });
    // Further store changes do not issue a second request while one is in flight.
    store.getState().actions.setView({ az: 10 });
    expect(calls).toHaveLength(1);
    calls[0]?.resolve(DEFAULTS);
    await flush();
    expect(store.getState().minorBodies).toEqual({
      defaults: DEFAULTS,
      status: 'ready',
      shown: 20,
    });
    // Once loaded, toggling the layer changes nothing.
    store.getState().actions.setLayer('minor', false);
    store.getState().actions.setLayer('minor', true);
    expect(calls).toHaveLength(1);
    stop();
  });

  it('does nothing when /meta has no minor_bodies catalog (degraded CI data set)', () => {
    const store = createSkyStore({ layers: ['stars', 'minor'] }, T0);
    const { calls, fetchDefaults } = fakeFetcher();
    const stop = startMinorBodies(store, { fetchDefaults });
    const catalogs: MetaResponse['catalogs'] = { stars: META.catalogs.stars };
    store.getState().actions.setMeta({ ...META, catalogs });
    expect(calls).toHaveLength(0);
    expect(store.getState().minorBodies.status).toBe('idle');
    stop();
  });

  it('records a 503 as missing, another failure as error, and retries on re-arming only', async () => {
    const store = createSkyStore({ layers: ['stars', 'minor'] }, T0);
    store.getState().actions.setMeta(META);
    const { calls, fetchDefaults } = fakeFetcher();
    const stop = startMinorBodies(store, { fetchDefaults });
    // Armed at start: the layer was already on.
    expect(calls).toHaveLength(1);
    calls[0]?.reject(
      new ApiProblem({
        status: 503,
        slug: 'data-not-ready',
        type: 'https://example.test#problem-data-not-ready',
        title: 'Data not ready',
        retryAfterS: 60,
      }),
    );
    await flush();
    expect(store.getState().minorBodies).toEqual({ defaults: null, status: 'missing', shown: 20 });
    // No automatic retry on unrelated changes.
    store.getState().actions.setView({ az: 5 });
    expect(calls).toHaveLength(1);
    // Toggling the layer re-arms one attempt.
    store.getState().actions.setLayer('minor', false);
    store.getState().actions.setLayer('minor', true);
    expect(calls).toHaveLength(2);
    calls[1]?.reject(new TypeError('Failed to fetch'));
    await flush();
    expect(store.getState().minorBodies.status).toBe('error');
    // "Retry now" re-arms as well.
    store.getState().actions.retryNow();
    expect(calls).toHaveLength(3);
    calls[2]?.resolve(DEFAULTS);
    await flush();
    expect(store.getState().minorBodies.status).toBe('ready');
    stop();
  });

  it('aborts the request in flight on stop and ignores its late settlement', async () => {
    const store = createSkyStore({ layers: ['stars', 'minor'] }, T0);
    store.getState().actions.setMeta(META);
    const { calls, fetchDefaults } = fakeFetcher();
    const abort = new AbortController();
    const stop = startMinorBodies(store, { fetchDefaults, signal: abort.signal });
    expect(calls).toHaveLength(1);
    abort.abort();
    expect(calls[0]?.signal.aborted).toBe(true);
    calls[0]?.resolve(DEFAULTS);
    await flush();
    // The store keeps the loading status: the caller decides what an aborted session shows.
    expect(store.getState().minorBodies.defaults).toBeNull();
    // Stopped: a later arming issues nothing, and stop() is idempotent.
    store.getState().actions.setLayer('minor', false);
    store.getState().actions.setLayer('minor', true);
    expect(calls).toHaveLength(1);
    stop();
  });

  it('uses the client by default and forwards the request options', async () => {
    const store = createSkyStore({ layers: ['stars', 'minor'] }, T0);
    store.getState().actions.setMeta(META);
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify(DEFAULTS), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    const stop = startMinorBodies(store, { requestOptions: { fetchImpl } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [input] = fetchImpl.mock.calls[0] ?? [];
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
    expect(url).toBe('/api/v1/minor-bodies/defaults');
    await flush();
    expect(store.getState().minorBodies.status).toBe('ready');
    expect(store.getState().minorBodies.defaults).toEqual(DEFAULTS);
    stop();
  });
});

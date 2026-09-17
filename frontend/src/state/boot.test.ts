// @vitest-environment node
// Boot sequence (plan D87): a fake fetch replays `/health` (starting with progress, a fatal
// detail, unreachable), `/meta` (503 back to health, step classes), the catalogs (degraded /meta
// without dso, stale ETag) and a fake engine; the phases and errors land in the store.

import type { MetaResponse } from '../api/client';
import { WebGL2UnavailableError } from '../sky/engine/types';
import type { SkyEngineApi } from '../sky/engine/types';
import { startBoot } from './boot';
import type { FrameController } from './frameController';
import { createSkyStore } from './store';
import type { SkyStore } from './storeTypes';
import { createFrameEval } from './types';
import type { BootPhase, BootState } from './types';

const NOW = Date.UTC(2026, 8, 6, 12, 0, 0);
const PROBLEM = 'https://github.com/j-about/InterSidera/blob/master/docs/api.md#problem-';
const HEALTH = '/api/v1/health';
const META = '/api/v1/meta';
const STARS = '/api/v1/catalogs/stars';
const INDEX = '/api/v1/catalogs/stars/index';
const DSO = '/api/v1/catalogs/dso';
const CON = '/api/v1/catalogs/constellations';

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function problem(status: number, slug: string, headers: Record<string, string> = {}): Response {
  return new Response(
    JSON.stringify({ type: `${PROBLEM}${slug}`, title: `Problem ${slug}`, status }),
    { status, headers: { 'Content-Type': 'application/problem+json', ...headers } },
  );
}

/** An empty SKYS v1 catalog: the 24-byte header alone (docs/api.md). */
function skysEmpty(etag = '"stars-etag"'): Response {
  const buffer = new ArrayBuffer(24);
  const view = new DataView(buffer);
  [0x53, 0x4b, 0x59, 0x53].forEach((byte, i) => {
    view.setUint8(i, byte);
  });
  view.setUint32(4, 1, true);
  view.setUint32(8, 0, true);
  view.setFloat64(12, 2451545, true);
  view.setUint32(20, 0, true);
  return new Response(buffer, {
    status: 200,
    headers: { 'Content-Type': 'application/octet-stream', ETag: etag },
  });
}

function makeMeta(catalogs: Partial<MetaResponse['catalogs']> = {}): MetaResponse {
  return {
    api_version: '1.0.0',
    server_time: { tt: 2461285.5, utc: '2026-09-02T00:00:00Z', tt_minus_utc_seconds: 69.3 },
    ephemeris: { name: 'de440s.bsp', coverage_tt: [2396758.5, 2506000.5] },
    observers: [],
    coverage: {
      ephemeris_tt: [2396758.5, 2506000.5],
      delta_t: { observed_tt: [2441317.5, 2461349.5], predicted_until_tt: 2461714.5 },
      iau_rotation_reliable_tt: [2378496.5, 2524593.5],
      proper_motion_warning_years: 10000,
      mpc_elements: { warn_years: 2, error_years: 50 },
    },
    bodies: [
      {
        id: 'sun',
        kind: 'star',
        name_key: 'bodies.sun',
        radius_km: 695700,
        step_class: 'sun_and_outer',
      },
      { id: 'moon', kind: 'moon', name_key: 'bodies.moon', radius_km: 1737, step_class: 'moon' },
    ],
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
      constellations: {
        count: 0,
        culture: 'modern',
        etag: 'con-etag',
        license: 'GPL-2.0',
        attribution: 'Stellarium; d3-celestial',
      },
      ...catalogs,
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

type Responder = () => Response | Promise<Response>;

/** Replay a list of responses per URL, repeating the last one; unknown URLs answer 404. */
function sequence(routes: Record<string, Responder[]>): ReturnType<typeof vi.fn<typeof fetch>> {
  const counts = new Map<string, number>();
  return vi.fn<typeof fetch>((input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const list = routes[url];
    if (list === undefined) {
      return Promise.resolve(new Response('not found', { status: 404 }));
    }
    const i = counts.get(url) ?? 0;
    counts.set(url, i + 1);
    const responder = list[Math.min(i, list.length - 1)];
    if (responder === undefined) {
      throw new Error(`no responder for ${url}`);
    }
    try {
      return Promise.resolve(responder());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

const catalogsOk: Record<string, Responder[]> = {
  [STARS]: [() => skysEmpty()],
  [INDEX]: [() => json(200, [])],
  [CON]: [() => json(200, { culture: 'modern', constellations: [] }, { ETag: '"con-etag"' })],
};

function calledUrls(fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>): string[] {
  return fetchImpl.mock.calls.map(([input]) =>
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
  );
}

type WhenCovering = FrameController['whenCovering'];
type SetCatalog = SkyEngineApi['setCatalog'];
type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

// The spies are handed back next to the fakes: asserting on `frames.whenCovering` would pass a
// method reference around (`@typescript-eslint/unbound-method`).
function fakeFrames(whenCovering: () => Promise<void> = () => Promise.resolve()): {
  frames: FrameController;
  whenCovering: ReturnType<typeof vi.fn<WhenCovering>>;
} {
  const spy = vi.fn<WhenCovering>(whenCovering);
  return {
    frames: {
      update: () => undefined,
      evaluate: () => undefined,
      whenCovering: spy,
      dispose: () => undefined,
      state: {
        current: null,
        next: null,
        inFlight: null,
        lastSnapshotDoneMs: 0,
        failedKey: null,
        failedShape: null,
      },
    },
    whenCovering: spy,
  };
}

function fakeEngine(): { engine: SkyEngineApi; setCatalog: ReturnType<typeof vi.fn<SetCatalog>> } {
  const setCatalog = vi.fn<SetCatalog>();
  return {
    engine: {
      backend: 'webgl2',
      adapterInfo: null,
      current: createFrameEval(0),
      // Never read by the boot; the node environment has no `document` to create one with.
      underlayRoot: {} as HTMLElement,
      setCatalog,
      currentTt: () => 0,
      whenReady: () => Promise.resolve(),
      fps: () => 60,
      frameMs: () => 1,
      starCount: () => 0,
      directionOf: () => false,
      readoutOf: () => false,
      pick: () => null,
      snapshot: () => Promise.reject(new Error('no snapshot in tests')),
      labelBoxes: () => [],
      skyBrightness: () => 0,
      layerStats: () => ({ dso: 0, clinesSegments: 0 }),
      reducedMotion: () => false,
      preloadXr: () => Promise.resolve(),
      enterXr: () => Promise.reject(new Error('no XR in tests')),
      exitXr: () => Promise.resolve(),
      arTransparent: () => false,
      resize: () => undefined,
      dispose: () => undefined,
    },
    setCatalog,
  };
}

function trackBoot(store: SkyStore): { phases: BootPhase[]; boots: BootState[] } {
  const phases: BootPhase[] = [];
  const boots: BootState[] = [];
  store.subscribe(
    (s) => s.boot,
    (boot) => {
      boots.push(boot);
      if (boot.phase !== phases[phases.length - 1]) {
        phases.push(boot.phase);
      }
    },
  );
  return { phases, boots };
}

const instantSleep: Sleep = () => Promise.resolve();
const sleepSpy = (): ReturnType<typeof vi.fn<Sleep>> => vi.fn<Sleep>(() => Promise.resolve());

describe('startBoot', () => {
  it('polls health, loads meta and catalogs, hands the stars to the engine and reaches ready', async () => {
    const starting = (downloaded: number) => ({
      status: 'starting' as const,
      version: '0.1.0',
      progress: { file: 'de440s.bsp', downloaded_bytes: downloaded, total_bytes: 2048 },
    });
    const degraded = { status: 'degraded' as const, version: '0.1.0', missing: ['mpc'] };
    const fetchImpl = sequence({
      [HEALTH]: [
        () => json(503, starting(1024), { 'Retry-After': '1' }),
        () => json(503, starting(2048)),
        () => json(200, degraded),
      ],
      [META]: [() => json(200, makeMeta({ dso: null }))],
      ...catalogsOk,
    });
    const sleep = sleepSpy();
    const store = createSkyStore({}, NOW);
    const { phases, boots } = trackBoot(store);
    const { frames, whenCovering } = fakeFrames();
    const { engine, setCatalog } = fakeEngine();
    const handle = startBoot({
      store,
      frames,
      engine: Promise.resolve(engine),
      signal: new AbortController().signal,
      fetchImpl,
      now: () => NOW,
      sleep,
    });
    expect(handle.catalog()).toBeNull();
    await handle.done;

    // The first `setBoot({ phase: 'health' })` is a change of the boot object, hence recorded.
    expect(phases).toEqual(['health', 'meta', 'catalogs', 'frame', 'ready']);
    expect(boots.map((b) => b.progress).filter((p) => p !== null)).toEqual([
      { file: 'de440s.bsp', downloadedBytes: 1024, totalBytes: 2048 },
      { file: 'de440s.bsp', downloadedBytes: 2048, totalBytes: 2048 },
    ]);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 5000]);
    const state = store.getState();
    expect(state.boot).toEqual({
      phase: 'ready',
      attempt: 0,
      retryAtMs: null,
      progress: null,
      error: null,
      retrySeq: 0,
    });
    expect(state.health).toEqual(degraded);
    expect(state.meta?.server_time.tt_minus_utc_seconds).toBe(69.3);
    expect(state.clock.ttMinusUtc).toBe(69.3);
    expect(state.catalogs).toEqual({
      stars: 'ready',
      index: 'ready',
      dso: 'missing',
      constellations: 'ready',
    });
    expect(calledUrls(fetchImpl)).not.toContain(DSO);
    expect(calledUrls(fetchImpl).filter((u) => u === HEALTH)).toHaveLength(3);
    const bundle = handle.bundle();
    expect(bundle?.dso).toBeNull();
    expect(bundle?.constellations?.data).toEqual([]);
    // The bundle is published to the store before the engine step (plan D92).
    expect(state.bundle).toBe(bundle);
    expect(setCatalog).toHaveBeenCalledTimes(1);
    expect(setCatalog).toHaveBeenCalledWith(bundle?.stars);
    expect(handle.catalog()).toBe(bundle?.stars);
    expect(handle.catalog()?.magnitudeLimit).toBe(13.9);
    expect(whenCovering).toHaveBeenCalledTimes(1);
  });

  it('surfaces a fatal startup detail and clears it when the API recovers', async () => {
    const fetchImpl = sequence({
      [HEALTH]: [
        () => json(503, { status: 'starting', version: '0.1.0', detail: 'de441.bsp is missing' }),
        () => json(200, { status: 'ready', version: '0.1.0' }),
      ],
      [META]: [() => json(200, makeMeta())],
      ...catalogsOk,
    });
    const store = createSkyStore({}, NOW);
    const { boots } = trackBoot(store);
    const handle = startBoot({
      store,
      frames: fakeFrames().frames,
      engine: Promise.resolve(fakeEngine().engine),
      signal: new AbortController().signal,
      fetchImpl,
      sleep: instantSleep,
    });
    await handle.done;
    expect(boots.map((b) => b.error)).toContainEqual({
      kind: 'fatal',
      detail: 'de441.bsp is missing',
    });
    expect(store.getState().boot).toMatchObject({ phase: 'ready', error: null });
    expect(store.getState().health?.status).toBe('ready');
  });

  it('reports an unreachable API with the attempt and the retry time while the client backs off', async () => {
    const fetchImpl = sequence({
      [HEALTH]: [
        () => Promise.reject(new TypeError('Failed to fetch')),
        () => Promise.reject(new TypeError('Failed to fetch')),
        () => json(200, { status: 'ready', version: '0.1.0' }),
      ],
      [META]: [() => json(200, makeMeta())],
      ...catalogsOk,
    });
    const sleep = sleepSpy();
    const store = createSkyStore({}, NOW);
    const { boots } = trackBoot(store);
    const handle = startBoot({
      store,
      frames: fakeFrames().frames,
      engine: Promise.resolve(fakeEngine().engine),
      signal: new AbortController().signal,
      fetchImpl,
      now: () => NOW,
      sleep,
    });
    await handle.done;
    // One `onRetry` per failed attempt (client.ts `pollHealth`), mirrored as one boot change.
    const unreachable = boots.filter((b) => b.error?.kind === 'unreachable');
    expect(unreachable.map((b) => b.attempt)).toEqual([1, 2]);
    // Full jitter over 500 ms then 1 s (client policy): retryAtMs is now + the slept delay.
    const delays = sleep.mock.calls.map((c) => c[0]);
    expect(delays).toHaveLength(2);
    expect(delays[0]).toBeGreaterThanOrEqual(0);
    expect(delays[0]).toBeLessThanOrEqual(500);
    expect(delays[1]).toBeLessThanOrEqual(1000);
    expect(unreachable.map((b) => b.retryAtMs)).toEqual([
      NOW + (delays[0] ?? NaN),
      NOW + (delays[1] ?? NaN),
    ]);
    // The 200 that follows clears the counter before `/meta`.
    const cleared = boots.findIndex((b) => b.phase === 'meta');
    expect(boots[cleared]).toMatchObject({ attempt: 0, retryAtMs: null, error: null });
    expect(store.getState().boot).toEqual({
      phase: 'ready',
      attempt: 0,
      retryAtMs: null,
      progress: null,
      error: null,
      retrySeq: 0,
    });
  });

  it('goes back to /health when /meta answers 503', async () => {
    const fetchImpl = sequence({
      [HEALTH]: [() => json(200, { status: 'ready', version: '0.1.0' })],
      [META]: [
        () => problem(503, 'data-not-ready', { 'Retry-After': '1' }),
        () => json(200, makeMeta()),
      ],
      ...catalogsOk,
    });
    const store = createSkyStore({}, NOW);
    const { phases } = trackBoot(store);
    const handle = startBoot({
      store,
      frames: fakeFrames().frames,
      engine: Promise.resolve(fakeEngine().engine),
      signal: new AbortController().signal,
      fetchImpl,
      sleep: instantSleep,
    });
    await handle.done;
    expect(phases).toEqual(['health', 'meta', 'health', 'meta', 'catalogs', 'frame', 'ready']);
    expect(calledUrls(fetchImpl).filter((u) => u === HEALTH)).toHaveLength(2);
    expect(calledUrls(fetchImpl).filter((u) => u === META)).toHaveLength(2);
  });

  it('reports a stale star catalog and still reaches ready', async () => {
    const fetchImpl = sequence({
      [HEALTH]: [() => json(200, { status: 'ready', version: '0.1.0' })],
      [META]: [() => json(200, makeMeta())],
      ...catalogsOk,
      [STARS]: [() => skysEmpty('"older-stars"')],
    });
    const store = createSkyStore({}, NOW);
    const handle = startBoot({
      store,
      frames: fakeFrames().frames,
      engine: Promise.resolve(fakeEngine().engine),
      signal: new AbortController().signal,
      fetchImpl,
      sleep: instantSleep,
    });
    await handle.done;
    expect(store.getState().catalogs.stars).toBe('stale');
    expect(store.getState().boot.phase).toBe('ready');
    expect(handle.bundle()?.starsStale).toBe(true);
  });

  it('ends in the webgl2 error when the engine cannot be created', async () => {
    const fetchImpl = sequence({
      [HEALTH]: [() => json(200, { status: 'ready', version: '0.1.0' })],
      [META]: [() => json(200, makeMeta())],
      ...catalogsOk,
    });
    const store = createSkyStore({}, NOW);
    const { frames, whenCovering } = fakeFrames();
    const handle = startBoot({
      store,
      frames,
      engine: Promise.reject(new WebGL2UnavailableError()),
      signal: new AbortController().signal,
      fetchImpl,
      sleep: instantSleep,
    });
    await handle.done;
    expect(store.getState().boot).toMatchObject({ phase: 'error', error: { kind: 'webgl2' } });
    expect(whenCovering).not.toHaveBeenCalled();
    expect(handle.catalog()).not.toBeNull();
  });

  it('maps a non-retryable status to an http error and a contract drift to a fatal one', async () => {
    const notFound = sequence({ [HEALTH]: [() => new Response('nope', { status: 404 })] });
    const store = createSkyStore({}, NOW);
    await startBoot({
      store,
      frames: fakeFrames().frames,
      engine: Promise.resolve(fakeEngine().engine),
      signal: new AbortController().signal,
      fetchImpl: notFound,
      sleep: instantSleep,
    }).done;
    expect(store.getState().boot).toMatchObject({
      phase: 'error',
      error: { kind: 'http', status: 404 },
    });

    const meta = makeMeta();
    meta.bodies.push({
      id: 'vulcan',
      kind: 'planet',
      name_key: 'bodies.vulcan',
      radius_km: 1,
      step_class: 'bogus',
    });
    const drift = sequence({
      [HEALTH]: [() => json(200, { status: 'ready', version: '0.1.0' })],
      [META]: [() => json(200, meta)],
    });
    const store2 = createSkyStore({}, NOW);
    await startBoot({
      store: store2,
      frames: fakeFrames().frames,
      engine: Promise.resolve(fakeEngine().engine),
      signal: new AbortController().signal,
      fetchImpl: drift,
      sleep: instantSleep,
    }).done;
    expect(store2.getState().boot.phase).toBe('error');
    expect(store2.getState().boot.error).toMatchObject({
      kind: 'fatal',
      detail: expect.stringContaining('bogus') as string,
    });
    expect(store2.getState().meta).toBeNull();
  });

  it('stops silently when aborted, during health polling or while waiting for the first frame', async () => {
    // Health: a 503 whose wait never ends until the abort.
    const abort = new AbortController();
    const pendingSleep = (_ms: number, signal?: AbortSignal): Promise<void> =>
      new Promise<void>((_, reject) => {
        signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    const fetchImpl = sequence({
      [HEALTH]: [() => json(503, { status: 'starting', version: '0.1.0' }, { 'Retry-After': '5' })],
    });
    const store = createSkyStore({}, NOW);
    const handle = startBoot({
      store,
      frames: fakeFrames().frames,
      engine: Promise.resolve(fakeEngine().engine),
      signal: abort.signal,
      fetchImpl,
      sleep: pendingSleep,
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    abort.abort();
    await handle.done;
    expect(store.getState().boot.phase).toBe('health');
    expect(store.getState().boot.error).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Frame phase: `whenCovering` never resolves; the abort must not leave the boot hanging.
    const abort2 = new AbortController();
    const ok = sequence({
      [HEALTH]: [() => json(200, { status: 'ready', version: '0.1.0' })],
      [META]: [() => json(200, makeMeta())],
      ...catalogsOk,
    });
    const store2 = createSkyStore({}, NOW);
    const { frames } = fakeFrames(() => new Promise<void>(() => undefined));
    const handle2 = startBoot({
      store: store2,
      frames,
      engine: Promise.resolve(fakeEngine().engine),
      signal: abort2.signal,
      fetchImpl: ok,
      sleep: instantSleep,
    });
    for (let i = 0; i < 20 && store2.getState().boot.phase !== 'frame'; i += 1) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    }
    expect(store2.getState().boot.phase).toBe('frame');
    abort2.abort();
    await handle2.done;
    expect(store2.getState().boot.phase).toBe('frame');

    // Engine phase: a factory that never settles (and ignores its own signal) must not leave the
    // boot hanging either; the catalogs are kept for a later retry.
    const abort3 = new AbortController();
    const store3 = createSkyStore({}, NOW);
    const handle3 = startBoot({
      store: store3,
      frames: fakeFrames().frames,
      engine: new Promise<SkyEngineApi>(() => undefined),
      signal: abort3.signal,
      fetchImpl: sequence({
        [HEALTH]: [() => json(200, { status: 'ready', version: '0.1.0' })],
        [META]: [() => json(200, makeMeta())],
        ...catalogsOk,
      }),
      sleep: instantSleep,
    });
    for (let i = 0; i < 20 && handle3.bundle() === null; i += 1) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    }
    expect(handle3.bundle()).not.toBeNull();
    abort3.abort();
    await handle3.done;
    expect(store3.getState().boot).toMatchObject({ phase: 'catalogs', error: null });
  });

  it('ends with an http error when the first frame request is refused for good', async () => {
    // `whenCovering` would wait forever: the controller has recorded a blocked request (a 422
    // outside the coverage) while no window is loaded, so the boot must not leave the splash up.
    const store = createSkyStore({}, NOW);
    const { phases } = trackBoot(store);
    const { frames } = fakeFrames(() => new Promise<void>(() => undefined));
    const handle = startBoot({
      store,
      frames,
      engine: Promise.resolve(fakeEngine().engine),
      signal: new AbortController().signal,
      fetchImpl: sequence({
        [HEALTH]: [() => json(200, { status: 'ready', version: '0.1.0' })],
        [META]: [() => json(200, makeMeta())],
        ...catalogsOk,
      }),
      sleep: instantSleep,
    });
    for (let i = 0; i < 20 && store.getState().boot.phase !== 'frame'; i += 1) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    }
    expect(store.getState().boot.phase).toBe('frame');
    // A transient failure keeps the boot waiting (the controller retries with backoff).
    store
      .getState()
      .actions.setFrames({ status: 'error', lastError: { status: 0, blocked: false } });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(store.getState().boot.phase).toBe('frame');
    store
      .getState()
      .actions.setFrames({ status: 'error', lastError: { status: 422, blocked: true } });
    await handle.done;
    expect(store.getState().boot).toMatchObject({
      phase: 'error',
      error: { kind: 'http', status: 422 },
    });
    expect(phases).toEqual(['health', 'meta', 'catalogs', 'frame', 'error']);
  });
});

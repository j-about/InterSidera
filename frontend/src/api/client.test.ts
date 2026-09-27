// API client (plan D77): typed query serialization, RFC 9457 problems, the retry policy with an
// injected clock, sleeper and fetch so every case runs instantly, `/health` polling, and the
// OBS-7 observer rounding.

import {
  ApiProblem,
  NetworkError,
  backoffDelayMs,
  getAltAz,
  getBytes,
  getFrame,
  getJson,
  getMeta,
  getMinorDefaults,
  isAbortError,
  observerQuery,
  parseRetryAfter,
  pollHealth,
  problemSlugOf,
  searchMinorBodies,
  serializeQuery,
} from './client';
import type { HealthPollOptions, HealthResponse, RequestOptions, RetryHook } from './client';

const NOW = Date.UTC(2026, 8, 6, 12, 0, 0);
const PROBLEM_BASE = 'https://github.com/j-about/InterSidera/blob/master/docs/api.md#problem-';

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function problemResponse(
  status: number,
  slug: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  return new Response(
    JSON.stringify({ type: `${PROBLEM_BASE}${slug}`, title: `Problem ${slug}`, status, ...extra }),
    { status, headers: { 'Content-Type': 'application/problem+json', ...headers } },
  );
}

function abortError(): DOMException {
  return new DOMException('The user aborted a request.', 'AbortError');
}

function requestUrl(fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>, call = 0): string {
  const args = fetchImpl.mock.calls[call];
  if (args === undefined) {
    throw new Error(`fetch call ${String(call)} missing`);
  }
  const [input] = args;
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

type Sleep = NonNullable<RequestOptions['sleep']>;
const instantSleep: Sleep = () => Promise.resolve();
const sleepSpy = (): ReturnType<typeof vi.fn<Sleep>> => vi.fn<Sleep>(() => Promise.resolve());

describe('serializeQuery', () => {
  it('sorts keys, encodes booleans as 1/0, skips undefined and null, keeps , : / readable', () => {
    expect(
      serializeQuery({
        tt: 2460409.25,
        lat: 51.48,
        body: 'earth',
        refraction: true,
        minor: undefined,
        n: null,
        targets: 'hip:32349,moon,c:C/2023_A3',
        all: false,
      }),
    ).toBe(
      'all=0&body=earth&lat=51.48&refraction=1&targets=hip:32349,moon,c:C/2023_A3&tt=2460409.25',
    );
    expect(serializeQuery({ q: 'hale bopp&co' })).toBe('q=hale%20bopp%26co');
    expect(serializeQuery({})).toBe('');
  });
});

describe('getJson and the typed helpers', () => {
  it('builds the URL from the typed query and returns the body as the schema type', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, [{ id: 'moon', alt_deg: 10 }]));
    const { data, response } = await getAltAz(
      {
        body: 'earth',
        lat: 51.48,
        lon: 0,
        elev: 0,
        tt: 2460409.25,
        targets: 'moon',
        refraction: false,
      },
      { fetchImpl },
    );
    expect(requestUrl(fetchImpl)).toBe(
      '/api/v1/sky/altaz?body=earth&elev=0&lat=51.48&lon=0&refraction=0&targets=moon&tt=2460409.25',
    );
    expect(data[0]?.id).toBe('moon');
    expect(response.status).toBe(200);
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(init?.method).toBe('GET');
    expect(init?.cache).toBeUndefined();
  });

  it('reaches the minor-body endpoints with their typed queries (plan D102)', async () => {
    const summary = { id: 'a:1', designation: '(1) Ceres', kind: 'asteroid', elements_epoch_tt: 1 };
    // One `Response` per call: a body can be read once.
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(jsonResponse(200, [summary])));
    const defaults = await getMinorDefaults({ fetchImpl });
    expect(requestUrl(fetchImpl)).toBe('/api/v1/minor-bodies/defaults');
    expect(defaults.data[0]?.id).toBe('a:1');
    const search = await searchMinorBodies('hale bopp', 8, { fetchImpl });
    expect(requestUrl(fetchImpl, 1)).toBe('/api/v1/minor-bodies/search?limit=8&q=hale%20bopp');
    expect(search.data).toHaveLength(1);
  });

  it('omits the query for /meta and forwards cache and signal', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { api_version: '1.0.0' }));
    const controller = new AbortController();
    const { data } = await getMeta({ fetchImpl, cache: 'no-store', signal: controller.signal });
    expect(requestUrl(fetchImpl)).toBe('/api/v1/meta');
    expect(data.api_version).toBe('1.0.0');
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(init?.cache).toBe('no-store');
    expect(init?.signal).toBe(controller.signal);
  });

  it('skips optional undefined and null query members', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, {}));
    await getFrame(
      {
        body: 'earth',
        lat: 51.48,
        lon: 0,
        elev: 0,
        tt: 2460409.25,
        step_s: 300,
        n: 32,
        bodies: 'all',
        minor: null,
      },
      { fetchImpl },
    );
    expect(requestUrl(fetchImpl)).toBe(
      '/api/v1/sky/frame?bodies=all&body=earth&elev=0&lat=51.48&lon=0&n=32&step_s=300&tt=2460409.25',
    );
  });

  it('uses the platform fetch when none is injected', async () => {
    const platformFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { api_version: '1.0.0' }));
    vi.stubGlobal('fetch', platformFetch);
    try {
      const { data } = await getMeta();
      expect(data.api_version).toBe('1.0.0');
      expect(platformFetch).toHaveBeenCalledTimes(1);
      expect(requestUrl(platformFetch)).toBe('/api/v1/meta');
      expect(platformFetch.mock.calls[0]?.[1]?.method).toBe('GET');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('getBytes returns the raw buffer', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(bytes, { status: 200 }));
    const { buffer } = await getBytes('/api/v1/catalogs/stars', { fetchImpl });
    expect(Array.from(new Uint8Array(buffer))).toEqual([1, 2, 3, 4]);
    expect(requestUrl(fetchImpl)).toBe('/api/v1/catalogs/stars');
  });
});

describe('ApiProblem', () => {
  it('reads every problem+json field, the slug and Retry-After in seconds', async () => {
    const response = problemResponse(
      422,
      'outside-coverage',
      {
        detail: 'window leaves the ephemeris',
        instance: '/api/v1/sky/frame',
        range_tt: [2396758.5, 2506000.5],
        errors: [{ loc: ['query', 'tt'], msg: 'out of range', type: 'value_error' }],
      },
      { 'Retry-After': '3' },
    );
    const problem = await ApiProblem.fromResponse(response, NOW);
    expect(problem).toBeInstanceOf(ApiProblem);
    expect(problem).toBeInstanceOf(Error);
    expect(problem.name).toBe('ApiProblem');
    expect(problem.status).toBe(422);
    expect(problem.slug).toBe('outside-coverage');
    expect(problem.type).toBe(`${PROBLEM_BASE}outside-coverage`);
    expect(problem.title).toBe('Problem outside-coverage');
    expect(problem.detail).toBe('window leaves the ephemeris');
    expect(problem.instance).toBe('/api/v1/sky/frame');
    expect(problem.rangeTt).toEqual([2396758.5, 2506000.5]);
    expect(problem.errors).toEqual([
      { loc: ['query', 'tt'], msg: 'out of range', type: 'value_error' },
    ]);
    expect(problem.retryAfterS).toBe(3);
    expect(problem.message).toBe('Problem outside-coverage: window leaves the ephemeris');
  });

  it('parses Retry-After HTTP dates relative to now, never negative', async () => {
    const future = problemResponse(
      429,
      'rate-limited',
      {},
      { 'Retry-After': new Date(NOW + 90_000).toUTCString() },
    );
    expect((await ApiProblem.fromResponse(future, NOW)).retryAfterS).toBe(90);
    const past = problemResponse(
      429,
      'rate-limited',
      {},
      { 'Retry-After': new Date(NOW - 90_000).toUTCString() },
    );
    expect((await ApiProblem.fromResponse(past, NOW)).retryAfterS).toBe(0);
    const none = problemResponse(429, 'rate-limited');
    expect((await ApiProblem.fromResponse(none, NOW)).retryAfterS).toBeUndefined();
  });

  it('tolerates non-JSON and non-problem bodies', async () => {
    const html = new Response('<html>Bad Gateway</html>', {
      status: 502,
      statusText: 'Bad Gateway',
    });
    const problem = await ApiProblem.fromResponse(html, NOW);
    expect(problem.slug).toBe('http-error');
    expect(problem.status).toBe(502);
    expect(problem.title).toBe('Bad Gateway');
    expect(problem.detail).toBeUndefined();
    expect(problem.errors).toBeUndefined();
    expect(problem.rangeTt).toBeUndefined();

    const empty = new Response(null, { status: 500 });
    expect((await ApiProblem.fromResponse(empty, NOW)).title).toBe('HTTP 500');

    const notAProblem = jsonResponse(400, { message: 'nope' });
    expect((await ApiProblem.fromResponse(notAProblem, NOW)).slug).toBe('http-error');

    const malformedMembers = jsonResponse(400, {
      type: `${PROBLEM_BASE}invalid-parameter`,
      title: 'Invalid parameter',
      status: 400,
      detail: null,
      errors: [{ loc: 'query', msg: 1 }],
      range_tt: [1],
      instance: 5,
    });
    const parsed = await ApiProblem.fromResponse(malformedMembers, NOW);
    expect(parsed.slug).toBe('invalid-parameter');
    expect(parsed.detail).toBeUndefined();
    expect(parsed.errors).toBeUndefined();
    expect(parsed.rangeTt).toBeUndefined();
    expect(parsed.instance).toBeUndefined();
  });

  it('maps unknown type URIs to the unknown slug', () => {
    expect(problemSlugOf('https://example.org/other')).toBe('unknown');
    expect(problemSlugOf(`${PROBLEM_BASE}teapot`)).toBe('unknown');
    expect(problemSlugOf(`${PROBLEM_BASE}data-not-ready`)).toBe('data-not-ready');
    expect(problemSlugOf('')).toBe('unknown');
  });
});

describe('parseRetryAfter and backoffDelayMs', () => {
  it('parses delay-seconds and dates, rejects garbage', () => {
    expect(parseRetryAfter(null, NOW)).toBeUndefined();
    expect(parseRetryAfter(' 60 ', NOW)).toBe(60);
    expect(parseRetryAfter('0', NOW)).toBe(0);
    expect(parseRetryAfter('-5', NOW)).toBeUndefined();
    expect(parseRetryAfter('soon', NOW)).toBeUndefined();
    expect(parseRetryAfter(new Date(NOW + 1500).toUTCString(), NOW)).toBe(1);
  });

  it('honours Retry-After up to the cap, else full jitter capped at 30 s', () => {
    expect(backoffDelayMs(0, 5, () => 0.5)).toBe(5000);
    expect(backoffDelayMs(0, 120, () => 0.5)).toBe(60_000);
    expect(backoffDelayMs(0, 120, () => 0.5, 10)).toBe(10_000);
    expect(backoffDelayMs(0, undefined, () => 0.5)).toBe(250);
    expect(backoffDelayMs(3, undefined, () => 1)).toBe(4000);
    expect(backoffDelayMs(10, undefined, () => 1)).toBe(30_000);
    const jitter = backoffDelayMs(2, undefined);
    expect(jitter).toBeGreaterThanOrEqual(0);
    expect(jitter).toBeLessThanOrEqual(2000);
  });
});

describe('retry policy', () => {
  it('retries 429, 503 and network errors with the announced or jittered delay, then succeeds', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(problemResponse(429, 'rate-limited', {}, { 'Retry-After': '1' }))
      .mockResolvedValueOnce(problemResponse(503, 'data-not-ready'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(jsonResponse(200, { status: 'ready', version: '0.1.0' }));
    const sleep = sleepSpy();
    const { data } = await getJson('/api/v1/health', undefined, {
      fetchImpl,
      sleep,
      random: () => 0.5,
      now: () => NOW,
    });
    expect(data.status).toBe('ready');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([1000, 500, 1000]);
  });

  it('announces each retry through onRetry before its sleep, never the final failure (R70)', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(problemResponse(429, 'rate-limited', {}, { 'Retry-After': '2' }))
      .mockResolvedValueOnce(problemResponse(502, 'http-error'))
      .mockResolvedValueOnce(jsonResponse(200, { status: 'ready', version: '0.1.0' }));
    const order: string[] = [];
    const sleep: Sleep = (ms) => {
      order.push(`sleep ${String(ms)}`);
      return Promise.resolve();
    };
    const onRetry = vi.fn<RetryHook>((attempt, delayMs) => {
      order.push(`retry ${String(attempt)} ${String(delayMs)}`);
    });
    const { data } = await getJson('/api/v1/health', undefined, {
      fetchImpl,
      sleep,
      onRetry,
      random: () => 1,
      now: () => NOW,
    });
    expect(data.status).toBe('ready');
    // Attempt numbers count the failures from 1; the delay is the one slept right after.
    expect(order).toEqual([
      'retry 1 500',
      'sleep 500',
      'retry 2 2000',
      'sleep 2000',
      'retry 3 2000',
      'sleep 2000',
    ]);
    expect(onRetry.mock.calls[0]?.[2]).toBeInstanceOf(NetworkError);
    expect(onRetry.mock.calls[1]?.[2]).toMatchObject({ status: 429, retryAfterS: 2 });
    expect(onRetry.mock.calls[2]?.[2]).toMatchObject({ status: 502, slug: 'http-error' });

    // The last attempt's failure is thrown, not announced; a non-retryable status neither.
    const exhausted = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('offline'));
    const hook = vi.fn<RetryHook>();
    await expect(
      getJson('/api/v1/meta', undefined, {
        fetchImpl: exhausted,
        sleep: instantSleep,
        onRetry: hook,
        retry: { maxAttempts: 3 },
      }),
    ).rejects.toBeInstanceOf(NetworkError);
    expect(hook).toHaveBeenCalledTimes(2);
    expect(hook.mock.calls.map((call) => call[0])).toEqual([1, 2]);
    const refused = vi.fn<typeof fetch>().mockResolvedValue(problemResponse(404, 'unknown-object'));
    const silent = vi.fn<RetryHook>();
    await expect(
      getJson('/api/v1/meta', undefined, {
        fetchImpl: refused,
        sleep: instantSleep,
        onRetry: silent,
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(silent).not.toHaveBeenCalled();
  });

  it('does not retry 400, 404 or 422', async () => {
    for (const [status, slug] of [
      [400, 'invalid-parameter'],
      [404, 'unknown-object'],
      [422, 'outside-coverage'],
    ] as const) {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(problemResponse(status, slug));
      const sleep = sleepSpy();
      const failure = getJson('/api/v1/meta', undefined, { fetchImpl, sleep });
      await expect(failure).rejects.toBeInstanceOf(ApiProblem);
      await expect(failure).rejects.toMatchObject({ status, slug });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    }
  });

  it('gives up after maxAttempts with the last problem or a NetworkError', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(problemResponse(503, 'data-not-ready')));
    const sleep = sleepSpy();
    await expect(getJson('/api/v1/meta', undefined, { fetchImpl, sleep })).rejects.toMatchObject({
      slug: 'data-not-ready',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(sleep).toHaveBeenCalledTimes(4);

    const cause = new TypeError('Failed to fetch');
    const offline = vi.fn<typeof fetch>().mockRejectedValue(cause);
    const failure = getJson('/api/v1/meta', undefined, {
      fetchImpl: offline,
      sleep,
      retry: { maxAttempts: 2 },
    });
    await expect(failure).rejects.toBeInstanceOf(NetworkError);
    await expect(failure).rejects.toMatchObject({ name: 'NetworkError', cause });
    expect(offline).toHaveBeenCalledTimes(2);
  });

  it('honours a custom retryOnStatus and maxRetryAfterS', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(problemResponse(500, 'internal-error', {}, { 'Retry-After': '600' }))
      .mockResolvedValueOnce(jsonResponse(200, {}));
    const sleep = sleepSpy();
    await getJson('/api/v1/meta', undefined, {
      fetchImpl,
      sleep,
      retry: { retryOnStatus: (status) => status === 500, maxRetryAfterS: 20 },
    });
    expect(sleep).toHaveBeenCalledWith(20_000, undefined);
  });

  it('rethrows an AbortError untouched and never retries it', async () => {
    const error = abortError();
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(error);
    const sleep = sleepSpy();
    await expect(getJson('/api/v1/meta', undefined, { fetchImpl, sleep })).rejects.toBe(error);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(isAbortError(error)).toBe(true);
    expect(isAbortError(new TypeError('x'))).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });

  it('waits with the platform timer by default and stops sleeping when aborted', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(problemResponse(503, 'data-not-ready', {}, { 'Retry-After': '2' }))
        .mockResolvedValueOnce(jsonResponse(200, { status: 'ready', version: '0.1.0' }));
      const pending = getJson('/api/v1/health', undefined, { fetchImpl });
      await vi.advanceTimersByTimeAsync(1999);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      const { data } = await pending;
      expect(data.status).toBe('ready');

      const controller = new AbortController();
      const slow = vi
        .fn<typeof fetch>()
        .mockResolvedValue(problemResponse(503, 'data-not-ready', {}, { 'Retry-After': '30' }));
      const aborted = getJson('/api/v1/meta', undefined, {
        fetchImpl: slow,
        signal: controller.signal,
      });
      const settled = aborted.then(
        () => 'resolved',
        (reason: unknown) => reason,
      );
      await vi.advanceTimersByTimeAsync(10);
      controller.abort();
      const reason = await settled;
      expect(isAbortError(reason)).toBe(true);
      expect(slow).toHaveBeenCalledTimes(1);

      // Sleeping on an already aborted signal rejects at once.
      const already = new AbortController();
      already.abort();
      const late = getJson('/api/v1/meta', undefined, {
        fetchImpl: slow,
        signal: already.signal,
      }).then(
        () => 'resolved',
        (reason: unknown) => reason,
      );
      await vi.advanceTimersByTimeAsync(10);
      expect(isAbortError(await late)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('pollHealth', () => {
  const starting: HealthResponse = {
    status: 'starting',
    version: '0.1.0',
    progress: { file: 'de440s.bsp', downloaded_bytes: 1024, total_bytes: 2048 },
  };
  const failed: HealthResponse = {
    status: 'starting',
    version: '0.1.0',
    detail: 'de441.bsp is missing',
  };
  const ready: HealthResponse = { status: 'ready', version: '0.1.0' };

  it('surfaces each 503 body and waits Retry-After or 5 s until a 200', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(503, starting, { 'Retry-After': '2' }))
      .mockResolvedValueOnce(jsonResponse(503, failed))
      .mockResolvedValueOnce(jsonResponse(200, ready));
    const sleep = sleepSpy();
    const onUpdate = vi.fn();
    const result = await pollHealth({ fetchImpl, sleep, onUpdate, now: () => NOW });
    expect(result).toEqual(ready);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(requestUrl(fetchImpl)).toBe('/api/v1/health');
    expect(onUpdate.mock.calls).toEqual([
      [starting, 2],
      [failed, undefined],
    ]);
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([2000, 5000]);
  });

  it('keeps polling through network errors and retryable statuses on one exponential schedule', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(
        new Response('<html>502</html>', { status: 502, statusText: 'Bad Gateway' }),
      )
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(
        jsonResponse(200, { status: 'degraded', version: '0.1.0', missing: ['mpc'] }),
      );
    const sleep = sleepSpy();
    const onUpdate = vi.fn();
    const onRetry = vi.fn<NonNullable<HealthPollOptions['onRetry']>>();
    const result = await pollHealth({ fetchImpl, sleep, onUpdate, onRetry, random: () => 1 });
    expect(result.status).toBe('degraded');
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    // Network failures and the proxy 502 share one exponential schedule (brief l.281); the
    // bodiless 503 is the API answering: it waits the default 5 s, resets the schedule and
    // surfaces no update; the next network failure starts again at 500 ms.
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([500, 1000, 2000, 5000, 500]);
    expect(onUpdate).not.toHaveBeenCalled();
    // Every unreachable attempt is reported with its ordinal and delay for the boot status line
    // (plan D87 `boot.unreachable`), with the cause.
    expect(onRetry.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      [1, 500],
      [2, 1000],
      [3, 2000],
      [1, 500],
    ]);
    expect(onRetry.mock.calls[0]?.[2]).toBeInstanceOf(NetworkError);
    expect(onRetry.mock.calls[2]?.[2]).toBeInstanceOf(ApiProblem);
    expect(onRetry.mock.calls[2]?.[2]).toMatchObject({ status: 502, slug: 'http-error' });
  });

  it('honours Retry-After from a retryable proxy status while polling', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 504, headers: { 'Retry-After': '7' } }))
      .mockResolvedValueOnce(jsonResponse(200, { status: 'ready', version: '0.1.0' }));
    const sleep = sleepSpy();
    const onRetry = vi.fn<NonNullable<HealthPollOptions['onRetry']>>();
    await pollHealth({ fetchImpl, sleep, onRetry, random: () => 1 });
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([7000]);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]?.[1]).toBe(7000);
  });

  it('throws a non-retryable status and rethrows an abort', async () => {
    const notFound = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('nope', { status: 404, statusText: 'Not Found' }));
    await expect(pollHealth({ fetchImpl: notFound, sleep: instantSleep })).rejects.toMatchObject({
      status: 404,
      slug: 'http-error',
    });

    const error = abortError();
    const aborted = vi.fn<typeof fetch>().mockRejectedValue(error);
    await expect(pollHealth({ fetchImpl: aborted, sleep: instantSleep })).rejects.toBe(error);
  });
});

describe('observerQuery', () => {
  it('rounds to 0.01 degree and 1 m, wraps longitude and avoids -0 (OBS-7)', () => {
    expect(observerQuery({ body: 'earth', lat: 51.4779, lon: 180, elev: 45.6 })).toEqual({
      body: 'earth',
      lat: 51.48,
      lon: -180,
      elev: 46,
    });
    const nearZero = observerQuery({ body: 'mars', lat: -0.004, lon: -0.004, elev: -0.4 });
    expect(Object.is(nearZero.lat, 0)).toBe(true);
    expect(Object.is(nearZero.lon, 0)).toBe(true);
    expect(Object.is(nearZero.elev, 0)).toBe(true);
    expect(observerQuery({ body: 'earth', lat: 0, lon: 179.996, elev: 0 }).lon).toBe(-180);
    expect(observerQuery({ body: 'earth', lat: 0, lon: -190, elev: 0 }).lon).toBe(170);
    expect(observerQuery({ body: 'earth', lat: 48.8566, lon: 2.3522, elev: 35 })).toEqual({
      body: 'earth',
      lat: 48.86,
      lon: 2.35,
      elev: 35,
    });
  });
});

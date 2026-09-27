// The single fetch layer of the frontend (plan D77, rules/frontend.md). Typed from the generated
// `schema.d.ts` (brief l.103: the OpenAPI document is the contract, the types are generated and
// never hand-edited), with the retry policy the API asks for (brief l.106-107: 429 and 503 carry
// `Retry-After`; brief l.281: retries with backoff, never a tight loop). No dependency beyond the
// platform `fetch`; every side effect (fetch, clock, timer, randomness) is injectable for tests.

import { roundUrlValue, wrapLongitudeDeg } from '../state/url';
import type { Observer } from '../state/types';
import type { components, paths } from './schema';

export type Paths = paths;
type PathKey = keyof Paths;

/** The GET operation of a path. */
export type GetOp<P extends PathKey> = Paths[P]['get'];
/** The query object of a path (`undefined` when the operation takes none). */
export type QueryOf<P extends PathKey> = GetOp<P>['parameters']['query'];
/** The `application/json` body of the 200 response (`never` for the binary star catalog). */
export type Json200<P extends PathKey> = GetOp<P>['responses'][200]['content'] extends {
  'application/json': infer Body;
}
  ? Body
  : never;
/** Every path whose 200 response is JSON: all of them but `/api/v1/catalogs/stars`. */
export type JsonPath = { [P in PathKey]: [Json200<P>] extends [never] ? never : P }[PathKey];

export type FrameResponse = components['schemas']['FrameResponse'];
export type MetaResponse = components['schemas']['MetaResponse'];
export type HealthResponse = components['schemas']['HealthResponse'];
export type AltAzEntry = components['schemas']['AltAzEntry'];
export type MinorBodySummary = components['schemas']['MinorBodySummary'];
type Problem = components['schemas']['Problem'];
type ProblemError = components['schemas']['ProblemError'];

/** Slugs of docs/api.md "Problem types" (`type` ends in `#problem-<slug>`). */
export type ProblemSlug =
  | 'invalid-parameter'
  | 'unknown-object'
  | 'outside-coverage'
  | 'rate-limited'
  | 'data-not-ready'
  | 'http-error'
  | 'internal-error'
  | 'unknown';

const PROBLEM_SLUGS: readonly ProblemSlug[] = [
  'invalid-parameter',
  'unknown-object',
  'outside-coverage',
  'rate-limited',
  'data-not-ready',
  'http-error',
  'internal-error',
];

export interface RetryPolicy {
  /** Total attempts including the first one. */
  maxAttempts: number;
  retryOnStatus: (status: number) => boolean;
  /** A longer `Retry-After` is capped here (seconds). */
  maxRetryAfterS: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  retryOnStatus: (status) => status === 429 || status === 502 || status === 503 || status === 504,
  maxRetryAfterS: 60,
};

/**
 * Told before each retry sleep: `attempt` counts the consecutive failed attempts from 1,
 * `delayMs` is the wait before the next one and `cause` the failure being retried (a
 * `NetworkError`, or the `ApiProblem` of a retryable status). Never called for the last attempt,
 * whose failure is thrown instead.
 */
export type RetryHook = (
  attempt: number,
  delayMs: number,
  cause: NetworkError | ApiProblem,
) => void;

export interface RequestOptions {
  signal?: AbortSignal;
  retry?: Partial<RetryPolicy>;
  cache?: RequestCache;
  /** Injectable for tests; defaults to the platform `fetch`. */
  fetchImpl?: typeof fetch;
  /** Wall clock in milliseconds (`Retry-After` HTTP dates are relative to it). */
  now?: () => number;
  /** Waits `ms`, rejecting with the signal's reason when aborted. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Uniform random source for the jitter (tests inject a constant). */
  random?: () => number;
  /**
   * Called before each retry sleep of `requestWithRetry` (plan R70): the frame controller
   * publishes `frames.failing` from the first failed attempt instead of after the whole ladder
   * (up to 7.5 s), so the UX-6 banner appears at once while the picture keeps extrapolating.
   */
  onRetry?: RetryHook;
}

export type ProblemErrorEntry = ProblemError;

interface ApiProblemFields {
  status: number;
  slug: ProblemSlug;
  type: string;
  title: string;
  detail?: string;
  instance?: string;
  errors?: ProblemErrorEntry[];
  rangeTt?: [number, number];
  retryAfterS?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNumberPair(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'number'
  );
}

function isProblemError(value: unknown): value is ProblemError {
  return (
    isRecord(value) &&
    Array.isArray(value.loc) &&
    value.loc.every((part: unknown) => typeof part === 'string' || typeof part === 'number') &&
    typeof value.msg === 'string' &&
    typeof value.type === 'string'
  );
}

/** A problem document, or as much of one as the body allowed (fields absent when malformed). */
function isProblemBody(
  value: unknown,
): value is Pick<Problem, 'type' | 'title'> & Partial<Problem> {
  return isRecord(value) && typeof value.type === 'string' && typeof value.title === 'string';
}

export function problemSlugOf(type: string): ProblemSlug {
  const match = /#problem-([a-z-]+)$/.exec(type);
  const slug = match?.[1];
  return PROBLEM_SLUGS.find((known) => known === slug) ?? 'unknown';
}

/** An RFC 9457 problem answered by the API (brief l.106), or any non-2xx response. */
export class ApiProblem extends Error {
  readonly status: number;
  readonly slug: ProblemSlug;
  readonly type: string;
  readonly title: string;
  readonly detail: string | undefined;
  readonly instance: string | undefined;
  readonly errors: ProblemErrorEntry[] | undefined;
  /** Valid TT range of a 422 `outside-coverage` answer. */
  readonly rangeTt: [number, number] | undefined;
  /** `Retry-After` in seconds, when the response carried one. */
  readonly retryAfterS: number | undefined;

  constructor(fields: ApiProblemFields) {
    super(fields.detail === undefined ? fields.title : `${fields.title}: ${fields.detail}`);
    this.name = 'ApiProblem';
    this.status = fields.status;
    this.slug = fields.slug;
    this.type = fields.type;
    this.title = fields.title;
    this.detail = fields.detail;
    this.instance = fields.instance;
    this.errors = fields.errors;
    this.rangeTt = fields.rangeTt;
    this.retryAfterS = fields.retryAfterS;
  }

  /**
   * Build a problem from any non-2xx response. A body that is not a problem document (a proxy
   * error page, an empty 502) yields the `http-error` slug with the status text as title.
   */
  static async fromResponse(response: Response, nowMs: number): Promise<ApiProblem> {
    const retryAfterS = parseRetryAfter(response.headers.get('Retry-After'), nowMs);
    const body = await readBodyOrNull(response);
    const fields: ApiProblemFields = {
      status: response.status,
      slug: 'http-error',
      type: '',
      title: response.statusText === '' ? `HTTP ${String(response.status)}` : response.statusText,
    };
    if (retryAfterS !== undefined) {
      fields.retryAfterS = retryAfterS;
    }
    if (!isProblemBody(body)) {
      return new ApiProblem(fields);
    }
    fields.type = body.type;
    fields.title = body.title;
    fields.slug = problemSlugOf(body.type);
    if (typeof body.detail === 'string') {
      fields.detail = body.detail;
    }
    if (typeof body.instance === 'string') {
      fields.instance = body.instance;
    }
    if (Array.isArray(body.errors) && body.errors.every(isProblemError)) {
      fields.errors = body.errors;
    }
    if (isNumberPair(body.range_tt)) {
      fields.rangeTt = body.range_tt;
    }
    return new ApiProblem(fields);
  }
}

/** `fetch` itself failed (offline, DNS, CORS, connection reset); the API never answered. */
export class NetworkError extends Error {
  constructor(url: string, cause: unknown) {
    super(`network error requesting ${url}`, { cause });
    this.name = 'NetworkError';
  }
}

/**
 * Abort errors are rethrown untouched and never retried. The check is by name: in jsdom the
 * `DOMException` class does not extend the realm's `Error`, so `instanceof` is unreliable.
 */
export function isAbortError(error: unknown): boolean {
  return isRecord(error) && error.name === 'AbortError';
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error
    ? reason
    : new DOMException('The operation was aborted.', 'AbortError');
}

/** The JSON body of a response, `null` when there is none or it is not JSON. */
async function readBodyOrNull(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** Default `sleep`: a timer that rejects with the abort reason when the signal fires. */
function timerSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = (): void => {
      window.clearTimeout(id);
      if (signal !== undefined) {
        reject(abortReason(signal));
      }
    };
    const id = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Serialize a query: sorted keys, booleans as `1`/`0`, numbers through `String()`, `undefined`
 * and `null` skipped, percent-encoded but with `,` `:` `/` left readable (the API canonicalizes
 * on its side, brief l.102; sorted keys make identical requests share the browser cache).
 */
export function serializeQuery(
  query: Record<string, string | number | boolean | undefined | null>,
): string {
  const parts: string[] = [];
  for (const key of Object.keys(query).sort()) {
    const value = query[key];
    if (value === undefined || value === null) {
      continue;
    }
    const text =
      typeof value === 'boolean'
        ? value
          ? '1'
          : '0'
        : typeof value === 'number'
          ? String(value)
          : value;
    parts.push(`${encodeReadable(key)}=${encodeReadable(text)}`);
  }
  return parts.join('&');
}

function encodeReadable(text: string): string {
  return encodeURIComponent(text).replace(/%2C/gi, ',').replace(/%3A/gi, ':').replace(/%2F/gi, '/');
}

/**
 * `Retry-After` as a non-negative number of seconds: either delay-seconds or an HTTP-date
 * (RFC 9110 §10.2.3) relative to `nowMs`; `undefined` when absent or unparsable.
 */
export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (value === null) {
    return undefined;
  }
  const text = value.trim();
  if (/^\d+$/.test(text)) {
    return Number(text);
  }
  // Every HTTP-date form (IMF-fixdate, RFC 850, asctime) spells a month name; without letters
  // `Date.parse` would still turn a bare `-5` into a year.
  if (!/[A-Za-z]/.test(text)) {
    return undefined;
  }
  const dateMs = Date.parse(text);
  if (Number.isNaN(dateMs)) {
    return undefined;
  }
  return Math.max(0, (dateMs - nowMs) / 1000);
}

/**
 * Delay before attempt `attempt + 1` in milliseconds: `Retry-After` when the server sent one
 * (capped at `maxRetryAfterS`), else full jitter over an exponential schedule capped at 30 s
 * (brief l.281 "exponential backoff").
 */
export function backoffDelayMs(
  attempt: number,
  retryAfterS: number | undefined,
  random: () => number = () => Math.random(),
  maxRetryAfterS = 60,
): number {
  if (retryAfterS !== undefined) {
    return Math.min(retryAfterS, maxRetryAfterS) * 1000;
  }
  return random() * Math.min(30_000, 500 * 2 ** attempt);
}

interface ResolvedOptions {
  signal: AbortSignal | undefined;
  policy: RetryPolicy;
  init: RequestInit;
  fetchImpl: typeof fetch;
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  random: () => number;
  onRetry: RetryHook | undefined;
}

function resolveOptions(options: RequestOptions, accept: string): ResolvedOptions {
  const init: RequestInit = { method: 'GET', headers: { Accept: accept } };
  if (options.signal !== undefined) {
    init.signal = options.signal;
  }
  if (options.cache !== undefined) {
    init.cache = options.cache;
  }
  return {
    signal: options.signal,
    policy: { ...DEFAULT_RETRY_POLICY, ...options.retry },
    init,
    fetchImpl: options.fetchImpl ?? ((input, requestInit) => fetch(input, requestInit)),
    now: options.now ?? (() => Date.now()),
    sleep: options.sleep ?? timerSleep,
    random: options.random ?? (() => Math.random()),
    onRetry: options.onRetry,
  };
}

/**
 * Responses are trusted as the generated type (plan D77): the OpenAPI document is the contract
 * and CI fails on drift, so this is the single cast of the client. Problem bodies, which can come
 * from a proxy rather than the API, are validated field by field instead.
 */
async function readJson<T>(response: Response): Promise<T> {
  const body: unknown = await response.json();
  return body as T;
}

/**
 * GET with the retry policy; resolves with the first 2xx response, rejects otherwise. Each retry
 * is announced through `onRetry` (plan R70) before its sleep.
 */
async function requestWithRetry(url: string, resolved: ResolvedOptions): Promise<Response> {
  const { policy, fetchImpl, init, now, sleep, random, signal, onRetry } = resolved;
  for (let attempt = 0; ; attempt += 1) {
    const last = attempt + 1 >= policy.maxAttempts;
    let response: Response;
    try {
      response = await fetchImpl(url, init);
    } catch (error) {
      if (isAbortError(error) || last) {
        throw isAbortError(error) ? error : new NetworkError(url, error);
      }
      const delayMs = backoffDelayMs(attempt, undefined, random, policy.maxRetryAfterS);
      onRetry?.(attempt + 1, delayMs, new NetworkError(url, error));
      await sleep(delayMs, signal);
      continue;
    }
    if (response.ok) {
      return response;
    }
    const problem = await ApiProblem.fromResponse(response, now());
    if (last || !policy.retryOnStatus(response.status)) {
      throw problem;
    }
    const delayMs = backoffDelayMs(attempt, problem.retryAfterS, random, policy.maxRetryAfterS);
    onRetry?.(attempt + 1, delayMs, problem);
    await sleep(delayMs, signal);
  }
}

function urlFor(path: string, query: unknown): string {
  if (!isRecord(query)) {
    return path;
  }
  const record: Record<string, string | number | boolean | undefined | null> = {};
  for (const [key, value] of Object.entries(query)) {
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      value === undefined ||
      value === null
    ) {
      record[key] = value;
    }
  }
  const qs = serializeQuery(record);
  return qs === '' ? path : `${path}?${qs}`;
}

/** Typed GET of a JSON endpoint. */
export async function getJson<P extends JsonPath>(
  path: P,
  query: QueryOf<P>,
  options: RequestOptions = {},
): Promise<{ data: Json200<P>; response: Response }> {
  const resolved = resolveOptions(options, 'application/json, application/problem+json');
  const response = await requestWithRetry(urlFor(path, query), resolved);
  return { data: await readJson<Json200<P>>(response), response };
}

/** GET of the binary star catalog (SKYS v1, docs/api.md). */
export async function getBytes(
  path: '/api/v1/catalogs/stars',
  options: RequestOptions = {},
): Promise<{ buffer: ArrayBuffer; response: Response }> {
  const resolved = resolveOptions(options, 'application/octet-stream, application/problem+json');
  const response = await requestWithRetry(path, resolved);
  return { buffer: await response.arrayBuffer(), response };
}

function isHealthResponse(value: unknown): value is HealthResponse {
  return (
    isRecord(value) &&
    (value.status === 'starting' || value.status === 'ready' || value.status === 'degraded') &&
    typeof value.version === 'string'
  );
}

/** Default wait between `/health` polls while `starting` without `Retry-After` (docs/api.md). */
const HEALTH_POLL_S = 5;

export interface HealthPollOptions extends RequestOptions {
  /** A 503 `starting` body (download `progress` or a fatal `detail`) and the wait before the next poll. */
  onUpdate?: (health: HealthResponse, retryAfterS: number | undefined) => void;
  /**
   * The API could not be reached: `fetch` failed or a proxy answered a retryable status. The
   * poll waits `delayMs` before failed attempt `attempt + 1` (`attempt` counts consecutive
   * failures from 1), so `boot.ts` can fill `BootState.attempt` / `retryAtMs` and show
   * `boot.unreachable` (plan D87). A 503 from the API itself goes through `onUpdate` instead.
   * The same `RetryHook` shape as `RequestOptions.onRetry`, which the poll never forwards to
   * `requestWithRetry` (it runs its own loop).
   */
  onRetry?: RetryHook;
}

/**
 * Poll `/api/v1/health` until it answers 200 (`ready` or `degraded`, ADR-0008). A 503 carries a
 * `HealthResponse` (`starting`, with download `progress` or a fatal `detail`) that is surfaced
 * through `onUpdate`, then the poll waits `Retry-After` (default 5 s). Network errors and
 * retryable proxy statuses (502, 504, ...) share one exponential schedule (brief l.281) that an
 * answer from the API itself (200 or 503) resets, and are reported through `onRetry`. The loop
 * only ends with a 200, an abort, or a status that is neither 503 nor retryable (a 404 from a
 * misrouted proxy), which is thrown as an `ApiProblem`.
 */
export async function pollHealth(options: HealthPollOptions = {}): Promise<HealthResponse> {
  const { onUpdate, onRetry, ...requestOptions } = options;
  const resolved = resolveOptions(requestOptions, 'application/json, application/problem+json');
  const { fetchImpl, init, now, sleep, random, signal, policy } = resolved;
  const url = '/api/v1/health';
  let failures = 0;
  const backOff = async (cause: NetworkError | ApiProblem): Promise<void> => {
    const retryAfterS = cause instanceof ApiProblem ? cause.retryAfterS : undefined;
    const delayMs = backoffDelayMs(failures, retryAfterS, random, policy.maxRetryAfterS);
    failures += 1;
    onRetry?.(failures, delayMs, cause);
    await sleep(delayMs, signal);
  };
  for (;;) {
    let response: Response;
    try {
      response = await fetchImpl(url, init);
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      await backOff(new NetworkError(url, error));
      continue;
    }
    if (response.ok) {
      return readJson<HealthResponse>(response);
    }
    if (response.status === 503) {
      failures = 0;
      const retryAfterS = parseRetryAfter(response.headers.get('Retry-After'), now());
      const body = await readBodyOrNull(response);
      if (isHealthResponse(body)) {
        onUpdate?.(body, retryAfterS);
      }
      await sleep((retryAfterS ?? HEALTH_POLL_S) * 1000, signal);
      continue;
    }
    const problem = await ApiProblem.fromResponse(response, now());
    if (!policy.retryOnStatus(response.status)) {
      throw problem;
    }
    await backOff(problem);
  }
}

/**
 * The observer part of a `/sky/*` query (OBS-7, brief l.196): latitude and longitude rounded to
 * 0.01 degree before they leave the browser, longitude wrapped into `[-180, 180)` without `-0`,
 * elevation to 1 m. The same rounding the URL uses, so shared links and requests agree.
 */
export function observerQuery(observer: Observer): {
  body: string;
  lat: number;
  lon: number;
  elev: number;
} {
  return {
    body: observer.body,
    lat: roundUrlValue('lat', observer.lat),
    lon: wrapLongitudeDeg(roundUrlValue('lon', observer.lon)),
    elev: roundUrlValue('elev', observer.elev),
  };
}

export function getMeta(
  options?: RequestOptions,
): Promise<{ data: MetaResponse; response: Response }> {
  return getJson('/api/v1/meta', undefined, options);
}

export function getFrame(
  query: QueryOf<'/api/v1/sky/frame'>,
  options?: RequestOptions,
): Promise<{ data: FrameResponse; response: Response }> {
  return getJson('/api/v1/sky/frame', query, options);
}

export function getAltAz(
  query: QueryOf<'/api/v1/sky/altaz'>,
  options?: RequestOptions,
): Promise<{ data: AltAzEntry[]; response: Response }> {
  return getJson('/api/v1/sky/altaz', query, options);
}

/** `/minor-bodies/defaults` (SKY-4, plan D102): the server's brightest asteroids and comets. */
export function getMinorDefaults(
  options?: RequestOptions,
): Promise<{ data: MinorBodySummary[]; response: Response }> {
  return getJson('/api/v1/minor-bodies/defaults', undefined, options);
}

/** `/minor-bodies/search?q=&limit=` (INFO-2 minor-body search): at most `limit` summaries. */
export function searchMinorBodies(
  q: string,
  limit: number,
  options?: RequestOptions,
): Promise<{ data: MinorBodySummary[]; response: Response }> {
  return getJson('/api/v1/minor-bodies/search', { q, limit }, options);
}

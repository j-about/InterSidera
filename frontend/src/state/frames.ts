// Frame buffer policy (plan D76, brief l.67-70): the pure half of the frame buffer. It shapes a
// `/sky/frame` request from the simulation state, turns a response into typed-array storage,
// decides on every tick whether to fetch, prefetch, swap or extrapolate, and evaluates a window
// at an arbitrary `tt` for the engine. No I/O, no store, no timers: `frameController.ts` owns
// those. The only impure-looking import is `api/client.ts`, used for its pure query helpers
// (OBS-7 rounding and the canonical serialization) and the `FrameResponse` type.

import { observerQuery, serializeQuery } from '../api/client';
import type { FrameResponse } from '../api/client';
import type { components, paths } from '../api/schema';
import {
  extrapolateQuat,
  extrapolateScalar,
  interpolateLstHours,
  interpolateScalar,
  interpolateVec3,
  segmentFraction,
  segmentIndex,
  slerpAt,
} from '../sky/math/interpolation';
import { normalizeQ, setQ } from '../sky/math/quaternion';
import {
  DAY_S,
  DEFAULT_SAMPLES,
  alignTt0,
  clampStepSeconds,
  clampTt,
  isSnapshot,
  stepSecondsForSpeed,
} from '../sky/math/time';
import { quat, store3, store4, vec3 } from '../sky/math/typed';
import { normalize3 } from '../sky/math/vec3';
import type { ClockMode, FrameEval, Observer, SkyWarning } from './types';

/** The generated query of `GET /api/v1/sky/frame` (brief l.103: types come from the contract). */
export type FrameQuery = paths['/api/v1/sky/frame']['get']['parameters']['query'];

type WarningModel = components['schemas']['WarningModel'];
type SamplesModel = components['schemas']['SamplesModel'];
type BodyMeta = components['schemas']['BodyMeta'];
type LimitsMeta = components['schemas']['LimitsMeta'];

/** `/sky/frame` defaults (docs/api.md), used only to read a hand-built query without `n`/`step_s`. */
const API_DEFAULT_STEP_S = 60;
/** Prefetch when this fraction of the window is consumed in the direction of travel (brief l.69). */
export const PREFETCH_FRACTION = 0.7;
/** A speed change beyond this factor invalidates the buffer (brief l.69). */
export const SPEED_RATIO_LIMIT = 10;
/** Snapshot refetch cadence, at most 4 Hz (brief l.70). */
export const SNAPSHOT_MIN_INTERVAL_MS = 250;
/** Two aligned `tt0` closer than the API's 1e-8 day canonicalization are the same request. */
export const SNAPSHOT_TT_TOLERANCE_D = 1e-8;
/**
 * A coverage bound is not itself requestable: the API canonicalizes `tt` to 1e-8 day and the
 * `/meta` bounds are not on that grid, so a window flush with a bound is rounded across it about
 * half of the time (measured against the live API: `tt0 = start` and `tt0 = end - 31 s` are both
 * 422). The clock therefore stops one guard inside the bound (`clampInsideCoverage`) and a
 * bounded window ends half a guard inside it (`boundedRequest`): every sample stays inside after
 * the rounding and the stopped time stays covered. 86 ms, invisible in the sky.
 */
export const COVERAGE_GUARD_D = 1e-6;

/** Per-body sample channels of one minor body (`samples: null` when `mpc_unreliable`). */
export interface MinorSamples {
  dir: Float64Array;
  distAu: Float64Array;
  mag: Float64Array;
  phase: Float64Array;
  diamDeg: Float64Array;
}

export interface MinorSeries {
  id: string;
  name?: string;
  kind: string;
  elementsEpochTt: number;
  extrapolationYears: number;
  warnings: SkyWarning[];
  samples: MinorSamples | null;
}

/**
 * One `/sky/frame` response as typed arrays (plan D76: at most two windows live at a time).
 * Body channels are body-major: body `b`, sample `i` sits at `3 * (b * n + i)` in `dir` and at
 * `b * n + i` in the scalar channels; `mag` holds `NaN` where the API sent `null`.
 */
export interface FrameWindow {
  /** Canonical query string of `request` (`requestKey`). */
  key: string;
  request: FrameQuery;
  /** Effective speed when the request was built (live counts as 1, paused as 0). */
  speedAtRequest: number;
  /** Echoed `time.tt0`, TT Julian Date of sample 0. */
  tt0: number;
  /** Echoed `time.step_s` in days. */
  stepD: number;
  n: number;
  /** `tt0 + (n - 1) * stepD`. */
  ttEnd: number;
  ttMinusUtc: number;
  /** ICRF -> ENU per sample, `4 n`, renormalised. */
  horizonQ: Float64Array;
  /** ICRF -> true equator and equinox of date per sample, `4 n`, renormalised. */
  equinoxQ: Float64Array;
  /** Barycentric observer velocity per sample, `3 n`, au/day. */
  observerVelocity: Float64Array;
  /** Observer -> Sun unit vectors per sample, `3 n`. */
  sunDir: Float64Array;
  /** Local apparent sidereal time per sample in hours, `null` off Earth. */
  lst: Float64Array | null;
  bodyIds: string[];
  bodyKinds: string[];
  dir: Float64Array;
  distAu: Float64Array;
  mag: Float64Array;
  phase: Float64Array;
  diamDeg: Float64Array;
  minor: MinorSeries[];
  warnings: { observer: SkyWarning[]; time: SkyWarning[] };
}

/** What the fetch policy needs from the simulation on one tick. */
export interface SimInput {
  observer: Observer;
  tt: number;
  /** Signed simulated seconds per real second (0 while paused or live). */
  speed: number;
  mode: ClockMode;
  /** `/meta.bodies[].id` minus the observer body. */
  bodyIds: readonly string[];
  /** `/meta.bodies[].id` -> `step_class`. */
  stepClassOf: ReadonlyMap<string, string>;
  /** `/meta.limits.max_step_s`. */
  maxStepS: Readonly<Record<string, number>>;
  /** Pinned minor-body ids (always empty at M3). */
  minor: readonly string[];
}

export interface FetchState {
  current: FrameWindow | null;
  next: FrameWindow | null;
  /** `speed` is the effective speed the request was shaped for (`FrameWindow.speedAtRequest`). */
  inFlight: { request: FrameQuery; key: string; startedMs: number; speed: number } | null;
  /** Wall time when the last snapshot request settled (success or failure). */
  lastSnapshotDoneMs: number;
  /**
   * The exact request the server refused at a coverage bound (422); never re-issued until the
   * simulation changes (a time change is one, so the key keeps its `tt`).
   */
  failedKey: string | null;
  /**
   * A request shape (`shapeKey`) refused for good (another 4xx, a 503 with a long `Retry-After`,
   * plan D76): never re-issued while the shape lasts, whatever the time does.
   */
  failedShape: string | null;
}

export type FetchReason =
  | 'initial'
  | 'observer'
  | 'bodies'
  | 'speed'
  | 'jump'
  | 'prefetch'
  | 'snapshot'
  /** The refetch flush with a coverage bound after a 422 (`boundedRequest`). */
  | 'bound';

export interface Decision {
  mode: 'window' | 'snapshot';
  /** The request to start now (cancelling an in-flight one with another key), or none. */
  fetch: FrameQuery | null;
  reason: FetchReason | null;
  /** `tt` entered `next`: promote it to `current`. */
  swapToNext: boolean;
  /** `next` (after any swap) no longer matches the simulation. */
  dropNext: boolean;
  /** `current` (after any swap) is a window and `tt` lies outside it (brief l.69). */
  extrapolating: boolean;
}

// Scratch storage of `windowFromResponse` and `evaluate` (never allocated per call).
const scratchQ = quat();
const scratchV = vec3();

/**
 * `/meta.bodies[].step_class` -> `/meta.limits.max_step_s` lookup tables, validated once at
 * `/meta` load (plan D76): an unknown class is a contract drift and throws `RangeError` here
 * rather than inside the render loop.
 */
export function stepClassesOf(
  bodies: readonly BodyMeta[],
  limits: LimitsMeta,
): { stepClassOf: ReadonlyMap<string, string>; maxStepS: Readonly<Record<string, number>> } {
  const maxStepS: Record<string, number> = { ...limits.max_step_s };
  const stepClassOf = new Map<string, string>();
  for (const body of bodies) {
    if (!Object.hasOwn(maxStepS, body.step_class)) {
      throw new RangeError(
        `body ${body.id} has step class ${body.step_class}, absent from limits.max_step_s`,
      );
    }
    stepClassOf.set(body.id, body.step_class);
  }
  return { stepClassOf, maxStepS };
}

/**
 * The speed the request is shaped for: live mode runs at 1x although its control block says 0
 * (plan D75), paused stays 0 so `buildRequest` and `decide` treat it as a still forward clock.
 */
export function effectiveSpeed(sim: SimInput): number {
  return sim.mode === 'live' ? 1 : sim.speed;
}

/** The canonical query string: sorted `key=value` pairs, the cache key the API also uses (brief l.102). */
export function requestKey(request: FrameQuery): string {
  return serializeQuery({ ...request });
}

/**
 * The request without its `tt`: the identity of a shape (observer, body set, step, sample count)
 * across the alignment grid, which moves `tt0` one bucket per `step_s` of simulated time. The
 * backoff ladder and the refusals that do not depend on the time are keyed on it.
 */
export function shapeKey(request: FrameQuery): string {
  return serializeQuery({ ...request, tt: undefined });
}

/**
 * Shape the request for the simulation state (plan D76, brief l.70): `step_s` from the speed,
 * clamped through the body classes; window mode places the current time in the second segment
 * for `speed >= 0` and in the last one for `speed < 0` (one sample beyond for the tangent);
 * snapshot mode (`n = 1`) asks for the aligned sample alone. `tt0` is aligned to the step grid
 * so users watching the same sky share cache keys (brief l.102).
 */
export function buildRequest(sim: SimInput): FrameQuery {
  const speed = effectiveSpeed(sim);
  const observer = observerQuery(sim.observer);
  const stepS = clampStepSeconds(
    stepSecondsForSpeed(speed),
    sim.bodyIds,
    sim.stepClassOf,
    sim.maxStepS,
    sim.minor.length > 0,
  );
  const stepD = stepS / DAY_S;
  const aligned = alignTt0(sim.tt, stepS);
  const snapshot = isSnapshot(stepS, DEFAULT_SAMPLES, speed);
  const n = snapshot ? 1 : DEFAULT_SAMPLES;
  let tt = aligned;
  if (!snapshot) {
    tt = speed >= 0 ? aligned - stepD : aligned - (n - 2) * stepD;
  }
  const request: FrameQuery = {
    body: observer.body,
    lat: observer.lat,
    lon: observer.lon,
    elev: observer.elev,
    tt,
    step_s: stepS,
    n,
    bodies: 'all',
  };
  if (sim.minor.length > 0) {
    request.minor = sim.minor.join(',');
  }
  return request;
}

function toSkyWarning(model: WarningModel): SkyWarning {
  const warning: SkyWarning = { code: model.code };
  if (model.params !== undefined && model.params !== null) {
    warning.params = model.params;
  }
  if (model.range_tt !== undefined && model.range_tt !== null) {
    warning.rangeTt = model.range_tt;
  }
  return warning;
}

function expectLength(label: string, actual: number, expected: number): void {
  if (actual !== expected) {
    throw new RangeError(
      `${label} has ${String(actual)} samples, the window announces ${String(expected)}`,
    );
  }
}

/** `list[i]` for a list whose length was checked; a hole is still a shape error. */
function element<T>(label: string, list: readonly T[], i: number): T {
  const value = list[i];
  if (value === undefined) {
    throw new RangeError(`${label}[${String(i)}] is missing`);
  }
  return value;
}

/** Flatten a quaternion series into `4 n`, renormalising after the API's 9-decimal rounding. */
function quaternionSeries(
  label: string,
  q: readonly (readonly number[])[],
  n: number,
): Float64Array {
  expectLength(label, q.length, n);
  const out = new Float64Array(4 * n);
  for (let i = 0; i < n; i += 1) {
    const [x, y, z, w] = element(label, q, i);
    if (x === undefined || y === undefined || z === undefined || w === undefined) {
      throw new RangeError(`${label}[${String(i)}] is not a quaternion`);
    }
    normalizeQ(scratchQ, setQ(scratchQ, x, y, z, w));
    store4(out, 4 * i, scratchQ);
  }
  return out;
}

function vectorSeries(label: string, v: readonly (readonly number[])[], n: number): Float64Array {
  expectLength(label, v.length, n);
  const out = new Float64Array(3 * n);
  for (let i = 0; i < n; i += 1) {
    const [x, y, z] = element(label, v, i);
    if (x === undefined || y === undefined || z === undefined) {
      throw new RangeError(`${label}[${String(i)}] is not a 3-vector`);
    }
    out[3 * i] = x;
    out[3 * i + 1] = y;
    out[3 * i + 2] = z;
  }
  return out;
}

function scalarSeries(
  label: string,
  values: readonly (number | null)[],
  n: number,
  out: Float64Array,
  offset: number,
): void {
  expectLength(label, values.length, n);
  for (let i = 0; i < n; i += 1) {
    out[offset + i] = element(label, values, i) ?? NaN;
  }
}

/** Copy one body's channels into the body-major layout at block `b` of `n` samples. */
function fillSamples(
  label: string,
  samples: SamplesModel,
  n: number,
  b: number,
  target: MinorSamples,
): void {
  expectLength(`${label}.dir`, samples.dir.length, n);
  for (let i = 0; i < n; i += 1) {
    // The schema types `dir` as 3-tuples, so the destructure is exact once the row exists.
    const [x, y, z] = element(`${label}.dir`, samples.dir, i);
    const o = 3 * (b * n + i);
    target.dir[o] = x;
    target.dir[o + 1] = y;
    target.dir[o + 2] = z;
  }
  scalarSeries(`${label}.dist_au`, samples.dist_au, n, target.distAu, b * n);
  scalarSeries(`${label}.mag`, samples.mag, n, target.mag, b * n);
  scalarSeries(`${label}.phase`, samples.phase, n, target.phase, b * n);
  scalarSeries(`${label}.diam_deg`, samples.diam_deg, n, target.diamDeg, b * n);
}

function allocateSamples(n: number, bodies: number): MinorSamples {
  return {
    dir: new Float64Array(3 * n * bodies),
    distAu: new Float64Array(n * bodies),
    mag: new Float64Array(n * bodies),
    phase: new Float64Array(n * bodies),
    diamDeg: new Float64Array(n * bodies),
  };
}

/**
 * Build a window from a response, on the ECHOED `time.tt0/step_s/n` (plan D74: the API clamps
 * `step_s` and canonicalizes `tt`). Every series length is validated here so `at()` never throws
 * inside the render loop; a mismatch is a `RangeError` the controller treats as a bad response.
 */
export function windowFromResponse(
  response: FrameResponse,
  request: FrameQuery,
  speedAtRequest: number,
): FrameWindow {
  const { time } = response;
  const n = time.n;
  if (!Number.isInteger(n) || n < 1) {
    throw new RangeError(`time.n must be a positive integer, got ${String(n)}`);
  }
  if (!(time.step_s > 0)) {
    throw new RangeError(`time.step_s must be positive, got ${String(time.step_s)}`);
  }
  const stepD = time.step_s / DAY_S;
  const bodyCount = response.bodies.length;
  const horizonQ = quaternionSeries('horizon.q', response.horizon.q, n);
  const equinoxQ = quaternionSeries('equinox_of_date.q', response.equinox_of_date.q, n);
  const observerVelocity = vectorSeries(
    'observer_velocity_au_d',
    response.observer_velocity_au_d,
    n,
  );
  const sunDir = vectorSeries('sun_dir', response.sun_dir, n);
  let lst: Float64Array | null = null;
  if (time.lst_hours !== undefined && time.lst_hours !== null) {
    lst = new Float64Array(n);
    scalarSeries('time.lst_hours', time.lst_hours, n, lst, 0);
  }
  const bodies = allocateSamples(n, bodyCount);
  const bodyIds: string[] = [];
  const bodyKinds: string[] = [];
  response.bodies.forEach((body, b) => {
    bodyIds.push(body.id);
    bodyKinds.push(body.kind);
    fillSamples(`bodies[${body.id}]`, body.samples, n, b, bodies);
  });
  const minor: MinorSeries[] = response.minor.map((entry) => {
    let samples: MinorSamples | null = null;
    if (entry.samples !== undefined && entry.samples !== null) {
      samples = allocateSamples(n, 1);
      fillSamples(`minor[${entry.id}]`, entry.samples, n, 0, samples);
    }
    const series: MinorSeries = {
      id: entry.id,
      kind: entry.kind,
      elementsEpochTt: entry.elements_epoch_tt,
      extrapolationYears: entry.extrapolation_years,
      warnings: entry.warnings.map(toSkyWarning),
      samples,
    };
    if (entry.name !== undefined && entry.name !== null) {
      series.name = entry.name;
    }
    return series;
  });
  return {
    key: requestKey(request),
    request,
    speedAtRequest,
    tt0: time.tt0,
    stepD,
    n,
    ttEnd: time.tt0 + (n - 1) * stepD,
    ttMinusUtc: time.tt_minus_utc_seconds,
    horizonQ,
    equinoxQ,
    observerVelocity,
    sunDir,
    lst,
    bodyIds,
    bodyKinds,
    dir: bodies.dir,
    distAu: bodies.distAu,
    mag: bodies.mag,
    phase: bodies.phase,
    diamDeg: bodies.diamDeg,
    minor,
    warnings: {
      observer: response.observer.warnings.map(toSkyWarning),
      time: time.warnings.map(toSkyWarning),
    },
  };
}

/** `tt` lies inside the window's sample span (a snapshot covers only its instant). */
export function windowCovers(window: FrameWindow, tt: number): boolean {
  return tt >= window.tt0 && tt <= window.ttEnd;
}

/** The span a request asks for, before its response arrives. */
function requestCovers(request: FrameQuery, tt: number): boolean {
  const n = request.n ?? DEFAULT_SAMPLES;
  const stepD = (request.step_s ?? API_DEFAULT_STEP_S) / DAY_S;
  return tt >= request.tt && tt <= request.tt + (n - 1) * stepD;
}

/** Where the clock stops when a request left `range` (plan D76 "pause at `range_tt`", TIME-4). */
export function clampInsideCoverage(tt: number, range: readonly [number, number]): number {
  return clampTt(tt, [range[0] + COVERAGE_GUARD_D, range[1] - COVERAGE_GUARD_D]);
}

/**
 * The same request shifted so that every sample lies half a guard inside `range`, or `null` when
 * it already does (the refusal is then not about this window). With `n >= 3` the shifted window
 * still contains every time `clampInsideCoverage` can produce: `buildRequest` places the time
 * within two steps (forward) or `n - 1` steps (backward) of `tt0`, and the shift moves the window
 * toward the time. A snapshot lands on the guarded bound (`readyCovers` tolerates the gap).
 */
export function boundedRequest(
  request: FrameQuery,
  range: readonly [number, number],
): FrameQuery | null {
  const n = request.n ?? DEFAULT_SAMPLES;
  const stepD = (request.step_s ?? API_DEFAULT_STEP_S) / DAY_S;
  const span = (n - 1) * stepD;
  const lo = range[0] + COVERAGE_GUARD_D / 2;
  const hi = range[1] - COVERAGE_GUARD_D / 2;
  if (request.tt + span > hi) {
    return { ...request, tt: hi - span };
  }
  if (request.tt < lo) {
    return { ...request, tt: lo };
  }
  return null;
}

/**
 * Fraction of the window consumed in the direction of travel (brief l.69): from `tt0` forward,
 * from `ttEnd` backward. A snapshot counts as fully consumed.
 */
export function consumed(window: FrameWindow, tt: number, speed: number): number {
  const span = (window.n - 1) * window.stepD;
  if (!(span > 0)) {
    return 1;
  }
  return speed >= 0 ? (tt - window.tt0) / span : (window.ttEnd - tt) / span;
}

function sameObserver(a: FrameQuery, b: FrameQuery): boolean {
  return a.body === b.body && a.lat === b.lat && a.lon === b.lon && a.elev === b.elev;
}

function sameBodies(a: FrameQuery, b: FrameQuery): boolean {
  return a.bodies === b.bodies && (a.minor ?? '') === (b.minor ?? '');
}

/**
 * Speed trigger (brief l.69): a sign change or a ratio beyond 10 against the speed the window
 * was fetched for. Pausing (`speed === 0`) keeps the buffer. Both speeds are floored at 1x
 * because `stepSecondsForSpeed` floors the step at 1 s (plan D75): every speed below about
 * 0.5x, paused included, produces the same window, so a paused-time request counts as 1x.
 */
function speedInvalidates(speed: number, speedAtRequest: number): boolean {
  if (speed === 0) {
    return false;
  }
  if (speed < 0 !== speedAtRequest < 0) {
    return true;
  }
  const ratio = Math.max(Math.abs(speed), 1) / Math.max(Math.abs(speedAtRequest), 1);
  return ratio > SPEED_RATIO_LIMIT || ratio < 1 / SPEED_RATIO_LIMIT;
}

function invalidationReason(
  current: FrameWindow | null,
  request: FrameQuery,
  speed: number,
  snapshotMode: boolean,
): FetchReason | null {
  if (current === null) {
    return 'initial';
  }
  if (!sameObserver(current.request, request)) {
    return 'observer';
  }
  if (!sameBodies(current.request, request)) {
    return 'bodies';
  }
  if (current.n < 2 !== snapshotMode) {
    return 'speed';
  }
  if (!snapshotMode && speedInvalidates(speed, current.speedAtRequest)) {
    return 'speed';
  }
  return null;
}

/**
 * The pending request is what the simulation would ask for now: same observer and body set, the
 * same mode, a speed the window would survive (`speedInvalidates`) and a span that still holds
 * `tt` (a pending snapshot is awaited whatever its instant, as the snapshot branch does).
 * `buildRequest` aligns `tt0` to the step grid, so the exact key moves one bucket per `step_s` of
 * simulated time: compared by key alone, a first request slower than one bucket (2 s in live
 * mode) would be cancelled and re-issued for ever and the picture would never arrive.
 */
function pendingMatches(
  pending: NonNullable<FetchState['inFlight']>,
  request: FrameQuery,
  speed: number,
  snapshotMode: boolean,
  tt: number,
): boolean {
  const p = pending.request;
  if (!sameObserver(p, request) || !sameBodies(p, request)) {
    return false;
  }
  if ((p.n ?? DEFAULT_SAMPLES) < 2 !== snapshotMode) {
    return false;
  }
  if (snapshotMode) {
    return true;
  }
  return !speedInvalidates(speed, pending.speed) && requestCovers(p, tt);
}

/** The window continuing `current` in the direction of travel, sharing the seam sample. */
function prefetchRequest(request: FrameQuery, current: FrameWindow, speed: number): FrameQuery {
  const n = DEFAULT_SAMPLES;
  const stepD = (request.step_s ?? API_DEFAULT_STEP_S) / DAY_S;
  return {
    ...request,
    n,
    tt: speed >= 0 ? current.ttEnd : current.tt0 - (n - 1) * stepD,
  };
}

/**
 * The fetch policy of brief l.67-70 for one tick. Order: promote `next` when `tt` entered it;
 * invalidate (initial, observer, body set, speed) and refetch at `tt`; in snapshot mode refetch
 * the aligned sample at most every 250 ms; in window mode refetch on a jump outside every known
 * span, else prefetch at 70 % consumption while the clock runs. A request already in flight with
 * the same key (or, under invalidation, the same shape still covering `tt`: `pendingMatches`), a
 * request the server refused (`failedKey`) or a refused shape (`failedShape`) is never issued.
 */
export function decide(state: FetchState, sim: SimInput, nowMs: number): Decision {
  const request = buildRequest(sim);
  const key = requestKey(request);
  const snapshotMode = request.n === 1;
  const speed = effectiveSpeed(sim);
  const tt = sim.tt;

  const swapToNext = state.next !== null && windowCovers(state.next, tt);
  const current = swapToNext ? state.next : state.current;
  const next = swapToNext ? null : state.next;
  const decision: Decision = {
    mode: snapshotMode ? 'snapshot' : 'window',
    fetch: null,
    reason: null,
    swapToNext,
    dropNext: false,
    extrapolating: current !== null && current.n > 1 && !windowCovers(current, tt),
  };
  const issue = (candidate: FrameQuery, candidateKey: string, reason: FetchReason): void => {
    if (
      state.inFlight?.key !== candidateKey &&
      candidateKey !== state.failedKey &&
      shapeKey(candidate) !== state.failedShape
    ) {
      decision.fetch = candidate;
      decision.reason = reason;
    }
  };

  const reason = invalidationReason(current, request, speed, snapshotMode);
  if (reason !== null || current === null) {
    decision.dropNext = next !== null;
    if (
      state.inFlight === null ||
      !pendingMatches(state.inFlight, request, speed, snapshotMode, tt)
    ) {
      issue(request, key, reason ?? 'initial');
    }
    return decision;
  }

  if (snapshotMode) {
    if (
      Math.abs(request.tt - current.tt0) > SNAPSHOT_TT_TOLERANCE_D &&
      state.inFlight === null &&
      nowMs - state.lastSnapshotDoneMs >= SNAPSHOT_MIN_INTERVAL_MS
    ) {
      issue(request, key, 'snapshot');
    }
    return decision;
  }

  const covered =
    windowCovers(current, tt) ||
    (next !== null && windowCovers(next, tt)) ||
    (state.inFlight !== null && requestCovers(state.inFlight.request, tt));
  if (!covered) {
    decision.dropNext = next !== null;
    issue(request, key, 'jump');
    return decision;
  }

  // A paused clock consumes nothing and has no direction of travel (brief l.69: pausing keeps
  // the buffer): a window fetched backward leaves `tt` near `ttEnd`, which a forward measure
  // would read as 90 % consumed and answer with a useless 1 s-step continuation on every pause.
  // Resuming runs this branch again with the real speed on the next tick.
  if (
    speed !== 0 &&
    next === null &&
    state.inFlight === null &&
    consumed(current, tt, speed) >= PREFETCH_FRACTION
  ) {
    const prefetch = prefetchRequest(request, current, speed);
    issue(prefetch, requestKey(prefetch), 'prefetch');
  }
  return decision;
}

/**
 * Evaluate a window at `tt` into `out` (plan D74): inside the window the interpolation kernels,
 * outside the linear continuation of the boundary samples (brief l.69); a snapshot (`n = 1`)
 * holds sample 0 everywhere. `out` must have room for every body (`RangeError` otherwise) and
 * nothing is allocated here.
 */
export function evaluate(window: FrameWindow, tt: number, out: FrameEval): void {
  const bodyCount = window.bodyIds.length;
  if (
    out.dir.length < 3 * bodyCount ||
    out.distAu.length < bodyCount ||
    out.mag.length < bodyCount ||
    out.phase.length < bodyCount ||
    out.diamDeg.length < bodyCount
  ) {
    throw new RangeError(
      `FrameEval holds ${String(out.distAu.length)} bodies, the window has ${String(bodyCount)}`,
    );
  }
  const { n, tt0, stepD } = window;
  const inside = n < 2 || windowCovers(window, tt);
  out.valid = true;
  out.snapshot = n < 2;
  out.extrapolating = !inside;
  out.tt = tt;
  out.ttMinusUtc = window.ttMinusUtc;
  out.bodyCount = bodyCount;
  out.bodyIds = window.bodyIds;
  out.bodyKinds = window.bodyKinds;

  if (inside) {
    const i = segmentIndex(tt0, stepD, n, tt);
    const u = n < 2 ? 0 : segmentFraction(tt0, stepD, i, tt);
    slerpAt(out.horizonQ, window.horizonQ, n, i, u);
    slerpAt(out.equinoxQ, window.equinoxQ, n, i, u);
    interpolateVec3(out.sunDir, window.sunDir, n, i, u, true);
    interpolateVec3(out.observerVelocity, window.observerVelocity, n, i, u, false);
    out.lstHours = window.lst === null ? NaN : interpolateLstHours(window.lst, n, i, u);
    for (let b = 0; b < bodyCount; b += 1) {
      const base = 3 * b * n;
      scratchV[0] = interpolateScalar(window.dir, n, i, u, 3, base);
      scratchV[1] = interpolateScalar(window.dir, n, i, u, 3, base + 1);
      scratchV[2] = interpolateScalar(window.dir, n, i, u, 3, base + 2);
      store3(out.dir, 3 * b, normalize3(scratchV, scratchV));
      out.distAu[b] = interpolateScalar(window.distAu, n, i, u, 1, b * n);
      out.mag[b] = interpolateScalar(window.mag, n, i, u, 1, b * n);
      out.phase[b] = interpolateScalar(window.phase, n, i, u, 1, b * n);
      out.diamDeg[b] = interpolateScalar(window.diamDeg, n, i, u, 1, b * n);
    }
    return;
  }

  extrapolateQuat(out.horizonQ, window.horizonQ, n, stepD, tt0, tt);
  extrapolateQuat(out.equinoxQ, window.equinoxQ, n, stepD, tt0, tt);
  out.sunDir[0] = extrapolateScalar(window.sunDir, n, stepD, tt0, tt, 3, 0);
  out.sunDir[1] = extrapolateScalar(window.sunDir, n, stepD, tt0, tt, 3, 1);
  out.sunDir[2] = extrapolateScalar(window.sunDir, n, stepD, tt0, tt, 3, 2);
  normalize3(out.sunDir, out.sunDir);
  out.observerVelocity[0] = extrapolateScalar(window.observerVelocity, n, stepD, tt0, tt, 3, 0);
  out.observerVelocity[1] = extrapolateScalar(window.observerVelocity, n, stepD, tt0, tt, 3, 1);
  out.observerVelocity[2] = extrapolateScalar(window.observerVelocity, n, stepD, tt0, tt, 3, 2);
  if (window.lst === null) {
    out.lstHours = NaN;
  } else {
    // `interpolateLstHours` unwraps the boundary difference on the 24 h circle and accepts a
    // fraction outside [0, 1], which is exactly the linear continuation wanted here.
    const i = tt < tt0 ? 0 : n - 2;
    out.lstHours = interpolateLstHours(window.lst, n, i, segmentFraction(tt0, stepD, i, tt));
  }
  for (let b = 0; b < bodyCount; b += 1) {
    const base = 3 * b * n;
    scratchV[0] = extrapolateScalar(window.dir, n, stepD, tt0, tt, 3, base);
    scratchV[1] = extrapolateScalar(window.dir, n, stepD, tt0, tt, 3, base + 1);
    scratchV[2] = extrapolateScalar(window.dir, n, stepD, tt0, tt, 3, base + 2);
    store3(out.dir, 3 * b, normalize3(scratchV, scratchV));
    out.distAu[b] = extrapolateScalar(window.distAu, n, stepD, tt0, tt, 1, b * n);
    out.mag[b] = extrapolateScalar(window.mag, n, stepD, tt0, tt, 1, b * n);
    out.phase[b] = extrapolateScalar(window.phase, n, stepD, tt0, tt, 1, b * n);
    out.diamDeg[b] = extrapolateScalar(window.diamDeg, n, stepD, tt0, tt, 1, b * n);
  }
}

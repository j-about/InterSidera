// @vitest-environment node
// Frame buffer policy (plan D76, brief l.67-70): windows built from the skyfield_frames.json
// fixture reshaped into a FrameResponse, evaluation parity at sample times and at the skipped
// samples of a half-density window (bodies within 1 arcsec), extrapolation beyond the window,
// request shaping for every clock state (OBS-7 rounding, step classes, snapshot mode) and the
// fetch decision for each trigger with a fake clock.

import type { FrameResponse } from '../api/client';
import type { components } from '../api/schema';
import {
  extrapolateDir,
  extrapolateQuat,
  interpolateDir,
  segmentFraction,
  slerpAt,
} from '../sky/math/interpolation';
import { normalizeQ, rotationAngle } from '../sky/math/quaternion';
import { DAY_S, alignTt0 } from '../sky/math/time';
import { at, load3, load4, quat, vec3 } from '../sky/math/typed';
import type { Quat, Vec3 } from '../sky/math/typed';
import { ARCSEC_PER_RAD, arcsecBetween3 } from '../sky/math/vec3';
import { loadFramesFixture } from '../test/fixtures';
import type { FrameWindowFixture } from '../test/fixtures';
import {
  COVERAGE_GUARD_D,
  PREFETCH_FRACTION,
  SNAPSHOT_MIN_INTERVAL_MS,
  boundedRequest,
  buildRequest,
  clampInsideCoverage,
  consumed,
  decide,
  effectiveSpeed,
  evaluate,
  requestKey,
  shapeKey,
  stepClassesOf,
  windowCovers,
  windowFromResponse,
} from './frames';
import type { FetchState, FrameQuery, FrameWindow, SimInput } from './frames';
import { createFrameEval } from './types';
import type { Observer } from './types';

type BodyKind = components['schemas']['FrameBody']['kind'];
type BodyMeta = components['schemas']['BodyMeta'];
type LimitsMeta = components['schemas']['LimitsMeta'];

const TT_MINUS_UTC = 69.2;
const frames = loadFramesFixture();

function windowNamed(id: string): FrameWindowFixture {
  const found = frames.windows.find((w) => w.id === id);
  if (found === undefined) {
    throw new Error(`fixture window ${id} missing`);
  }
  return found;
}

// Greenwich, 2024-04-08T18:00 TT, 32 samples every 300 s, ten bodies.
const greenwich = windowNamed('greenwich_2024-04-08T18_300s');

function kindOf(id: string): BodyKind {
  switch (id) {
    case 'sun':
      return 'star';
    case 'moon':
      return 'moon';
    case 'pluto':
      return 'dwarf_planet';
    default:
      return 'planet';
  }
}

interface AdapterOptions {
  /** Keep every `every`-th sample (a coarser grid the fixture then judges). */
  every?: number;
  /** Keep only the first `count` samples of the thinned grid. */
  count?: number;
  /** Add a synthetic `lst_hours` series (the fixture has none). */
  lst?: boolean;
  /** Replace one magnitude by `null`. */
  nullMag?: { body: string; index: number };
  warnings?: boolean;
  /** Add two minor bodies: one with `samples: null`, one with samples copied from a body. */
  minor?: boolean;
}

function pick<T>(list: readonly T[], stride: number, count: number): T[] {
  return list.filter((_, i) => i % stride === 0).slice(0, count);
}

/** Synthetic LST at the sidereal rate from 23.5 h, so the series wraps through 0 h. */
function syntheticLst(n: number, stepS: number): number[] {
  return Array.from({ length: n }, (_, i) => (23.5 + (i * stepS * 1.00273790935) / 3600) % 24);
}

/** Reshape a fixture window into the `FrameResponse` the API would serve for it. */
function responseFrom(w: FrameWindowFixture, opts: AdapterOptions = {}): FrameResponse {
  const stride = opts.every ?? 1;
  const n = pick(w.tt, stride, opts.count ?? w.n).length;
  const stepS = w.step_s * stride;
  const sub = <T>(list: readonly T[]): T[] => pick(list, stride, n);
  const bodies: FrameResponse['bodies'] = Object.entries(w.bodies)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, series]) => ({
      id,
      kind: kindOf(id),
      samples: {
        dir: sub(series.dir),
        dist_au: sub(series.dist_au),
        mag: sub(series.mag).map((m, i): number | null =>
          opts.nullMag?.body === id && opts.nullMag.index === i ? null : m,
        ),
        phase: sub(series.phase),
        diam_deg: sub(series.diam_deg),
      },
      warnings: [],
    }));
  const first = bodies[0];
  if (first === undefined) {
    throw new Error('fixture window without bodies');
  }
  const time: FrameResponse['time'] = {
    tt0: w.tt0,
    step_s: stepS,
    n,
    tt_minus_utc_seconds: TT_MINUS_UTC,
    utc0: '2024-04-08T17:58:50Z',
    warnings:
      opts.warnings === true
        ? [{ code: 'delta_t_approximate', range_tt: [2441317.5, 2461714.5] }]
        : [],
  };
  if (opts.lst === true) {
    time.lst_hours = syntheticLst(n, stepS);
  }
  return {
    observer: {
      body: w.observer,
      lat_deg: w.site.lat_deg,
      lon_deg: w.site.lon_deg,
      elev_m: w.site.elev_m,
      latitude_kind: w.site.latitude_kind === 'geodetic' ? 'geodetic' : 'planetocentric',
      warnings: opts.warnings === true ? [{ code: 'pluto_barycenter', params: null }] : [],
    },
    time,
    horizon: { q: sub(w.horizon_q) },
    equinox_of_date: { q: sub(w.equinox_q) },
    observer_velocity_au_d: sub(w.observer_velocity_au_d),
    sun_dir: sub(w.sun_dir),
    bodies,
    minor:
      opts.minor === true
        ? [
            {
              id: 'a:1',
              name: 'Ceres',
              kind: 'asteroid',
              samples: null,
              elements_epoch_tt: 2460200.5,
              extrapolation_years: 60.12,
              warnings: [
                { code: 'mpc_extrapolation', params: { years: 60.12 } },
                { code: 'mpc_unreliable', params: { years: 60.12 } },
              ],
            },
            {
              id: 'c:1P',
              kind: 'comet',
              samples: first.samples,
              elements_epoch_tt: 2460200.5,
              extrapolation_years: 0.5,
              warnings: [],
            },
          ]
        : [],
  };
}

function requestFor(w: FrameWindowFixture, n: number, stepS: number): FrameQuery {
  return {
    body: w.observer,
    lat: w.site.lat_deg,
    lon: w.site.lon_deg,
    elev: w.site.elev_m,
    tt: w.tt0,
    step_s: stepS,
    n,
    bodies: 'all',
  };
}

function quatAt(a: ArrayLike<number>, i: number): Quat {
  return load4(quat(), a, 4 * i);
}

function normLength(q: Quat): number {
  return Math.hypot(q[0], q[1], q[2], q[3]);
}

function bodyIndex(window: FrameWindow, id: string): number {
  const b = window.bodyIds.indexOf(id);
  if (b < 0) {
    throw new Error(`body ${id} missing`);
  }
  return b;
}

function fixtureDir(w: FrameWindowFixture, id: string, i: number): Vec3 {
  const series = w.bodies[id];
  const dir = series?.dir[i];
  if (dir === undefined) {
    throw new Error(`fixture ${id}[${String(i)}] missing`);
  }
  return dir;
}

function fixtureScalar(
  w: FrameWindowFixture,
  id: string,
  channel: 'dist_au' | 'mag' | 'phase' | 'diam_deg',
  i: number,
): number {
  const value = w.bodies[id]?.[channel][i];
  if (value === undefined) {
    throw new Error(`fixture ${id}.${channel}[${String(i)}] missing`);
  }
  return value;
}

function fixtureQuat(rows: readonly Quat[], i: number): Quat {
  const q = rows[i];
  if (q === undefined) {
    throw new Error(`fixture quaternion ${String(i)} missing`);
  }
  return normalizeQ(quat(), q);
}

function fixtureVec(rows: readonly Vec3[], i: number): Vec3 {
  const v = rows[i];
  if (v === undefined) {
    throw new Error(`fixture vector ${String(i)} missing`);
  }
  return v;
}

const arcsecQ = (a: Quat, b: Quat): number => rotationAngle(a, b) * ARCSEC_PER_RAD;

describe('windowFromResponse', () => {
  const request = requestFor(greenwich, 32, 300);

  it('lays the Greenwich window out body-major on the echoed grid', () => {
    const window = windowFromResponse(responseFrom(greenwich), request, 1);
    expect(window.n).toBe(32);
    expect(window.tt0).toBe(greenwich.tt0);
    expect(window.stepD).toBeCloseTo(300 / DAY_S, 15);
    expect(window.ttEnd).toBeCloseTo(greenwich.tt0 + (31 * 300) / DAY_S, 9);
    expect(window.ttMinusUtc).toBe(TT_MINUS_UTC);
    expect(window.speedAtRequest).toBe(1);
    expect(window.key).toBe(requestKey(request));
    expect(window.request).toBe(request);
    expect(window.bodyIds).toEqual(Object.keys(greenwich.bodies).sort());
    expect(window.bodyKinds[bodyIndex(window, 'sun')]).toBe('star');
    expect(window.bodyKinds[bodyIndex(window, 'pluto')]).toBe('dwarf_planet');
    expect(window.lst).toBeNull();
    expect(window.minor).toEqual([]);
    expect(window.warnings).toEqual({ observer: [], time: [] });

    const b = bodyIndex(window, 'moon');
    const n = window.n;
    expect(window.dir).toHaveLength(3 * n * window.bodyIds.length);
    expect(window.distAu).toHaveLength(n * window.bodyIds.length);
    for (const i of [0, 5, 31]) {
      expect(load3(vec3(), window.dir, 3 * (b * n + i))).toEqual(fixtureDir(greenwich, 'moon', i));
      expect(at(window.distAu, b * n + i)).toBe(fixtureScalar(greenwich, 'moon', 'dist_au', i));
      expect(at(window.mag, b * n + i)).toBe(fixtureScalar(greenwich, 'moon', 'mag', i));
      expect(at(window.phase, b * n + i)).toBe(fixtureScalar(greenwich, 'moon', 'phase', i));
      expect(at(window.diamDeg, b * n + i)).toBe(fixtureScalar(greenwich, 'moon', 'diam_deg', i));
      expect(load3(vec3(), window.sunDir, 3 * i)).toEqual(fixtureVec(greenwich.sun_dir, i));
      expect(load3(vec3(), window.observerVelocity, 3 * i)).toEqual(
        fixtureVec(greenwich.observer_velocity_au_d, i),
      );
    }
    // The API rounds quaternions to nine decimals; the window stores unit quaternions.
    for (let i = 0; i < n; i += 1) {
      expect(normLength(quatAt(window.horizonQ, i))).toBeCloseTo(1, 14);
      expect(normLength(quatAt(window.equinoxQ, i))).toBeCloseTo(1, 14);
      expect(arcsecQ(quatAt(window.horizonQ, i), fixtureQuat(greenwich.horizon_q, i))).toBeLessThan(
        1e-6,
      );
    }
  });

  it('stores null magnitudes as NaN, renormalises, keeps lst, minor bodies and warnings', () => {
    const response = responseFrom(greenwich, {
      lst: true,
      nullMag: { body: 'venus', index: 3 },
      warnings: true,
      minor: true,
    });
    // A grossly denormalised quaternion still comes out unit-length.
    const row = response.horizon.q[0];
    if (row === undefined) {
      throw new Error('missing quaternion');
    }
    response.horizon.q[0] = [row[0] * 1.5, row[1] * 1.5, row[2] * 1.5, row[3] * 1.5];
    const window = windowFromResponse(response, request, -60);

    expect(window.speedAtRequest).toBe(-60);
    expect(normLength(quatAt(window.horizonQ, 0))).toBeCloseTo(1, 14);
    const venus = bodyIndex(window, 'venus');
    expect(at(window.mag, venus * 32 + 3)).toBeNaN();
    expect(at(window.mag, venus * 32 + 2)).toBe(fixtureScalar(greenwich, 'venus', 'mag', 2));
    expect(window.lst).toHaveLength(32);
    expect(window.lst === null ? NaN : at(window.lst, 0)).toBeCloseTo(23.5, 12);
    expect(window.warnings.observer).toEqual([{ code: 'pluto_barycenter' }]);
    expect(window.warnings.time).toEqual([
      { code: 'delta_t_approximate', rangeTt: [2441317.5, 2461714.5] },
    ]);
    expect(window.warnings.observer[0]).not.toHaveProperty('params');

    expect(window.minor).toHaveLength(2);
    const [ceres, halley] = window.minor;
    expect(ceres).toMatchObject({
      id: 'a:1',
      name: 'Ceres',
      kind: 'asteroid',
      elementsEpochTt: 2460200.5,
      extrapolationYears: 60.12,
      samples: null,
    });
    expect(ceres?.warnings).toEqual([
      { code: 'mpc_extrapolation', params: { years: 60.12 } },
      { code: 'mpc_unreliable', params: { years: 60.12 } },
    ]);
    expect(halley).not.toHaveProperty('name');
    expect(halley?.samples?.dir).toHaveLength(3 * 32);
    expect(halley?.samples?.distAu).toHaveLength(32);
    const jupiter = window.bodyIds[0];
    expect(jupiter).toBe('jupiter');
    expect(
      halley?.samples === null || halley?.samples === undefined
        ? null
        : load3(vec3(), halley.samples.dir, 3 * 7),
    ).toEqual(fixtureDir(greenwich, 'jupiter', 7));
  });

  it('rejects a shape mismatch with RangeError before anything reaches the render loop', () => {
    const cases: [string, (r: FrameResponse) => void][] = [
      ['n = 0', (r) => (r.time.n = 0)],
      ['fractional n', (r) => (r.time.n = 31.5)],
      ['step_s = 0', (r) => (r.time.step_s = 0)],
      ['horizon.q short', (r) => (r.horizon.q = r.horizon.q.slice(0, 31))],
      ['equinox.q short', (r) => (r.equinox_of_date.q = r.equinox_of_date.q.slice(1))],
      ['velocity short', (r) => (r.observer_velocity_au_d = r.observer_velocity_au_d.slice(2))],
      ['sun_dir long', (r) => r.sun_dir.push([1, 0, 0])],
      ['lst_hours short', (r) => (r.time.lst_hours = [1, 2, 3])],
      [
        'body dist_au short',
        (r) => {
          const body = r.bodies[0];
          if (body !== undefined) {
            body.samples.dist_au = body.samples.dist_au.slice(0, 5);
          }
        },
      ],
      [
        'body dir short',
        (r) => {
          const body = r.bodies[3];
          if (body !== undefined) {
            body.samples.dir = body.samples.dir.slice(0, 5);
          }
        },
      ],
      [
        'body mag long',
        (r) => {
          const body = r.bodies[1];
          if (body !== undefined) {
            body.samples.mag = [...body.samples.mag, null];
          }
        },
      ],
      [
        'minor samples short',
        (r) => {
          const minor = r.minor[1];
          if (minor?.samples !== undefined && minor.samples !== null) {
            minor.samples.phase = minor.samples.phase.slice(0, 2);
          }
        },
      ],
    ];
    for (const [label, mutate] of cases) {
      const response = responseFrom(greenwich, { minor: true });
      mutate(response);
      expect(() => windowFromResponse(response, request, 1), label).toThrow(RangeError);
    }
  });
});

describe('evaluate', () => {
  const full = windowFromResponse(
    responseFrom(greenwich, { lst: true }),
    requestFor(greenwich, 32, 300),
    1,
  );
  const out = createFrameEval(16);

  it('reproduces every sample at the sample times', () => {
    const lst = syntheticLst(32, 300);
    for (let i = 0; i < 32; i += 1) {
      const tt = at(greenwich.tt, i);
      evaluate(full, tt, out);
      expect(out.valid).toBe(true);
      expect(out.extrapolating).toBe(false);
      expect(out.snapshot).toBe(false);
      expect(out.tt).toBe(tt);
      expect(out.ttMinusUtc).toBe(TT_MINUS_UTC);
      expect(out.bodyCount).toBe(10);
      expect(out.bodyIds).toBe(full.bodyIds);
      expect(out.bodyKinds).toBe(full.bodyKinds);
      // tt is about 2.46e6 days: float64 places a sample time within 1e-7 of a step, which the
      // Earth's 4500 arcsec of rotation per 300 s step turns into a few 1e-4 arcsec.
      expect(arcsecQ(out.horizonQ, fixtureQuat(greenwich.horizon_q, i))).toBeLessThan(1e-3);
      expect(arcsecQ(out.equinoxQ, fixtureQuat(greenwich.equinox_q, i))).toBeLessThan(1e-3);
      expect(arcsecBetween3(out.sunDir, fixtureVec(greenwich.sun_dir, i))).toBeLessThan(1e-5);
      const velocity = fixtureVec(greenwich.observer_velocity_au_d, i);
      for (const c of [0, 1, 2] as const) {
        expect(out.observerVelocity[c]).toBeCloseTo(velocity[c], 12);
      }
      // The fixture times sit 2^-24 of a step (6e-8) off the grid, so every channel moves by that
      // fraction of its per-step change (measured: LST 5e-9 h, Pluto's distance 3.3e-12 au, the
      // Moon's magnitude 3.9e-10, Mercury's phase 1.9e-12, the Moon's diameter 8.1e-12 deg); the
      // bounds below keep at least a 6x margin over those.
      expect(out.lstHours).toBeCloseTo(at(lst, i), 7);
      for (const [b, id] of full.bodyIds.entries()) {
        const dir = load3(vec3(), out.dir, 3 * b);
        expect(arcsecBetween3(dir, fixtureDir(greenwich, id, i))).toBeLessThan(1e-3);
        expect(at(out.distAu, b)).toBeCloseTo(fixtureScalar(greenwich, id, 'dist_au', i), 10);
        expect(at(out.mag, b)).toBeCloseTo(fixtureScalar(greenwich, id, 'mag', i), 8);
        expect(at(out.phase, b)).toBeCloseTo(fixtureScalar(greenwich, id, 'phase', i), 10);
        expect(at(out.diamDeg, b)).toBeCloseTo(fixtureScalar(greenwich, id, 'diam_deg', i), 10);
      }
    }
  });

  it('interpolates the skipped samples of a half-density window within 1 arcsec', () => {
    // Every second sample (16 at 600 s): the odd fixture samples are the truth at half steps.
    const half = windowFromResponse(
      responseFrom(greenwich, { every: 2, lst: true }),
      requestFor(greenwich, 16, 600),
      1,
    );
    const lst = syntheticLst(16, 600);
    let worstBody = 0;
    let worstHorizon = 0;
    let worstSun = 0;
    for (let i = 1; i < 30; i += 2) {
      const tt = at(greenwich.tt, i);
      evaluate(half, tt, out);
      expect(out.extrapolating).toBe(false);
      worstHorizon = Math.max(
        worstHorizon,
        arcsecQ(out.horizonQ, fixtureQuat(greenwich.horizon_q, i)),
        arcsecQ(out.equinoxQ, fixtureQuat(greenwich.equinox_q, i)),
      );
      worstSun = Math.max(worstSun, arcsecBetween3(out.sunDir, fixtureVec(greenwich.sun_dir, i)));
      const velocity = fixtureVec(greenwich.observer_velocity_au_d, i);
      for (const c of [0, 1, 2] as const) {
        expect(Math.abs(out.observerVelocity[c] - velocity[c])).toBeLessThan(1e-6);
      }
      // The synthetic LST is linear in time: the unwrapped interpolation is exact to rounding.
      const k = (i - 1) / 2;
      const expectedLst =
        (at(lst, k) + at(lst, k + 1) + (at(lst, k + 1) < at(lst, k) ? 24 : 0)) / 2;
      expect(out.lstHours).toBeCloseTo(expectedLst % 24, 6);
      for (const [b, id] of half.bodyIds.entries()) {
        const dir = load3(vec3(), out.dir, 3 * b);
        worstBody = Math.max(worstBody, arcsecBetween3(dir, fixtureDir(greenwich, id, i)));
        // Scalar bounds are 1e-6 with a 1.4x margin over the measured worst values, all on the
        // Moon (the fastest body): dist 7.0e-7 relative, phase 1.2e-7, diam 7.2e-7 relative;
        // every other body stays below 2e-8. Deterministic on the fixed fixture, so the margin
        // guards a future kernel change, not a flake.
        const dist = fixtureScalar(greenwich, id, 'dist_au', i);
        expect(Math.abs(at(out.distAu, b) - dist) / dist).toBeLessThan(1e-6);
        // Display-only channel (docs/api.md serialises `mag` to 3 decimals): the bound is half
        // that resolution. The Moon, a hair from new (phase 1e-5), has a kink in its fixture
        // magnitude at sample 21 that Hermite misses by 2.5e-4; every other body stays below 2e-8.
        expect(Math.abs(at(out.mag, b) - fixtureScalar(greenwich, id, 'mag', i))).toBeLessThan(
          5e-4,
        );
        expect(Math.abs(at(out.phase, b) - fixtureScalar(greenwich, id, 'phase', i))).toBeLessThan(
          1e-6,
        );
        const diam = fixtureScalar(greenwich, id, 'diam_deg', i);
        expect(Math.abs(at(out.diamDeg, b) - diam) / diam).toBeLessThan(1e-6);
      }
    }
    // Contractual bound 1 arcsec (rules/sky-math.md); measured 0.26 arcsec (plan D88).
    expect(worstBody).toBeLessThan(1);
    expect(worstHorizon).toBeLessThan(0.01);
    expect(worstSun).toBeLessThan(0.05);
  });

  it('matches the interpolation kernels body by body (layout offsets)', () => {
    const tt = greenwich.tt0 + 7.3 * full.stepD;
    // The fraction is recomputed from tt exactly as `evaluate` does (float64 puts it a few 1e-7
    // away from 0.3); only the layout offsets are under test here.
    const u = segmentFraction(full.tt0, full.stepD, 7, tt);
    evaluate(full, tt, out);
    const expected = vec3();
    const expectedQ = quat();
    slerpAt(expectedQ, full.horizonQ, full.n, 7, u);
    expect(arcsecQ(out.horizonQ, expectedQ)).toBeLessThan(1e-6);
    for (const [b] of full.bodyIds.entries()) {
      const series = full.dir.subarray(3 * b * full.n, 3 * (b + 1) * full.n);
      interpolateDir(expected, series, full.n, 7, u);
      expect(arcsecBetween3(load3(vec3(), out.dir, 3 * b), expected)).toBeLessThan(1e-6);
    }
  });

  it('extrapolates linearly beyond both ends from the boundary samples (brief l.69)', () => {
    // The first 16 samples; fixture sample 16 is the truth one step past the window end.
    const head = windowFromResponse(
      responseFrom(greenwich, { count: 16, lst: true }),
      requestFor(greenwich, 16, 300),
      1,
    );
    const lst = syntheticLst(16, 300);
    const beyond = at(greenwich.tt, 16);
    evaluate(head, beyond, out);
    expect(out.valid).toBe(true);
    expect(out.extrapolating).toBe(true);
    expect(out.snapshot).toBe(false);
    let worstBody = 0;
    for (const [b, id] of head.bodyIds.entries()) {
      const dir = load3(vec3(), out.dir, 3 * b);
      worstBody = Math.max(worstBody, arcsecBetween3(dir, fixtureDir(greenwich, id, 16)));
      // Same continuation the kernel computes on the body's own slice: the offsets are right.
      const series = head.dir.subarray(3 * b * head.n, 3 * (b + 1) * head.n);
      const expected = extrapolateDir(vec3(), series, head.n, head.stepD, head.tt0, beyond);
      expect(arcsecBetween3(dir, expected)).toBeLessThan(1e-6);
      const dist = fixtureScalar(greenwich, id, 'dist_au', 16);
      expect(Math.abs(at(out.distAu, b) - dist) / dist).toBeLessThan(1e-4);
    }
    // One step of linear continuation: the Moon's diurnal parallax bends the path by about an
    // arcsecond; the horizon rotation is uniform and continues almost exactly.
    expect(worstBody).toBeLessThan(5);
    const expectedQ = extrapolateQuat(quat(), head.horizonQ, head.n, head.stepD, head.tt0, beyond);
    expect(arcsecQ(out.horizonQ, expectedQ)).toBeLessThan(1e-6);
    expect(arcsecQ(out.horizonQ, fixtureQuat(greenwich.horizon_q, 16))).toBeLessThan(0.1);
    expect(arcsecBetween3(out.sunDir, fixtureVec(greenwich.sun_dir, 16))).toBeLessThan(0.1);
    expect(out.lstHours).toBeCloseTo((at(lst, 15) + (at(lst, 15) - at(lst, 14))) % 24, 6);

    // Before the window: continued from the first two samples.
    const before = head.tt0 - 0.5 * head.stepD;
    evaluate(head, before, out);
    expect(out.extrapolating).toBe(true);
    const moon = bodyIndex(head, 'moon');
    const series = head.dir.subarray(3 * moon * head.n, 3 * (moon + 1) * head.n);
    const expected = extrapolateDir(vec3(), series, head.n, head.stepD, head.tt0, before);
    expect(arcsecBetween3(load3(vec3(), out.dir, 3 * moon), expected)).toBeLessThan(1e-6);
    // Half a step back is about half the Moon's per-step motion (165 arcsec per 300 s).
    const backwards = arcsecBetween3(
      load3(vec3(), out.dir, 3 * moon),
      fixtureDir(greenwich, 'moon', 0),
    );
    expect(backwards).toBeGreaterThan(60);
    expect(backwards).toBeLessThan(110);
    expect(out.lstHours).toBeCloseTo((at(lst, 0) - 0.5 * (at(lst, 1) - at(lst, 0)) + 24) % 24, 6);
    const distBefore = at(out.distAu, moon);
    const d0 = fixtureScalar(greenwich, 'moon', 'dist_au', 0);
    const d1 = fixtureScalar(greenwich, 'moon', 'dist_au', 1);
    expect(distBefore).toBeCloseTo(d0 - 0.5 * (d1 - d0), 12);
    const velocity0 = fixtureVec(greenwich.observer_velocity_au_d, 0);
    const velocity1 = fixtureVec(greenwich.observer_velocity_au_d, 1);
    expect(out.observerVelocity[1]).toBeCloseTo(
      velocity0[1] - 0.5 * (velocity1[1] - velocity0[1]),
      12,
    );
  });

  it('holds the single sample of a snapshot window everywhere and reports it', () => {
    const snapshot = windowFromResponse(
      responseFrom(greenwich, { count: 1 }),
      requestFor(greenwich, 1, 300),
      86400,
    );
    expect(snapshot.n).toBe(1);
    expect(snapshot.ttEnd).toBe(snapshot.tt0);
    for (const tt of [snapshot.tt0 - 2, snapshot.tt0, snapshot.tt0 + 3]) {
      evaluate(snapshot, tt, out);
      expect(out.valid).toBe(true);
      expect(out.snapshot).toBe(true);
      expect(out.extrapolating).toBe(false);
      expect(out.tt).toBe(tt);
      expect(out.lstHours).toBeNaN();
      expect(arcsecQ(out.horizonQ, fixtureQuat(greenwich.horizon_q, 0))).toBeLessThan(1e-6);
      for (const [b, id] of snapshot.bodyIds.entries()) {
        const dir = load3(vec3(), out.dir, 3 * b);
        expect(arcsecBetween3(dir, fixtureDir(greenwich, id, 0))).toBeLessThan(1e-6);
        expect(at(out.distAu, b)).toBe(fixtureScalar(greenwich, id, 'dist_au', 0));
      }
    }
  });

  it('throws RangeError when the evaluation has no room for every body', () => {
    expect(() => {
      evaluate(full, greenwich.tt0, createFrameEval(2));
    }).toThrow(RangeError);
    expect(() => {
      evaluate(full, greenwich.tt0, createFrameEval(10));
    }).not.toThrow();
  });
});

// /meta as the API serves it (docs/api.md): eleven bodies in three step classes.
const META_BODIES: BodyMeta[] = (
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

const LIMITS: LimitsMeta = {
  max_samples: 64,
  max_minor_bodies: 100,
  max_targets: 200,
  speeds: [1, 10, 60, 600, 3600, 86400, 604800, 2629800, 31557600],
  max_step_s: { moon: 3600, inner_planets: 21600, sun_and_outer: 86400, minor: 86400 },
};

const { stepClassOf, maxStepS } = stepClassesOf(META_BODIES, LIMITS);
const ALL_IDS = META_BODIES.map((b) => b.id);
const EARTH_BODIES = ALL_IDS.filter((id) => id !== 'earth');
const MOON_BODIES = ALL_IDS.filter((id) => id !== 'moon');
const OBSERVER: Observer = { body: 'earth', lat: 51.4779, lon: -0.0015, elev: 45.6 };
const TT = 2460409.3123456;

function sim(patch: Partial<SimInput> = {}): SimInput {
  return {
    observer: OBSERVER,
    tt: TT,
    speed: 0,
    mode: 'paused',
    bodyIds: EARTH_BODIES,
    stepClassOf,
    maxStepS,
    minor: [],
    ...patch,
  };
}

function playing(speed: number, patch: Partial<SimInput> = {}): SimInput {
  return sim({ speed, mode: 'playing', ...patch });
}

describe('stepClassesOf', () => {
  it('maps every body to its class and copies the limits', () => {
    expect(stepClassOf.get('moon')).toBe('moon');
    expect(stepClassOf.get('mars')).toBe('inner_planets');
    expect(stepClassOf.get('pluto')).toBe('sun_and_outer');
    expect(maxStepS).toEqual(LIMITS.max_step_s);
    expect(maxStepS).not.toBe(LIMITS.max_step_s);
  });

  it('throws RangeError naming the body whose class is not a limits key', () => {
    const bodies: BodyMeta[] = [
      ...META_BODIES,
      {
        id: 'vulcan',
        kind: 'planet',
        name_key: 'bodies.vulcan',
        radius_km: 1,
        step_class: 'bogus',
      },
    ];
    expect(() => stepClassesOf(bodies, LIMITS)).toThrow(RangeError);
    expect(() => stepClassesOf(bodies, LIMITS)).toThrow(/vulcan.*bogus/);
  });
});

describe('buildRequest', () => {
  it('rounds the observer (OBS-7), aligns tt0 and places a paused clock one step in', () => {
    const request = buildRequest(sim());
    expect(request).toEqual({
      body: 'earth',
      lat: 51.48,
      lon: 0,
      elev: 46,
      tt: alignTt0(TT, 1) - 1 / DAY_S,
      step_s: 1,
      n: 32,
      bodies: 'all',
    });
    expect(request).not.toHaveProperty('minor');
    expect(Object.is(request.lon, -0)).toBe(false);
  });

  it('shapes live mode for 1x although the control block says 0', () => {
    const request = buildRequest(sim({ mode: 'live' }));
    expect(effectiveSpeed(sim({ mode: 'live' }))).toBe(1);
    expect(request.step_s).toBe(2);
    expect(request.n).toBe(32);
    expect(request.tt).toBeCloseTo(alignTt0(TT, 2) - 2 / DAY_S, 12);
  });

  it('puts the current time in the second segment forward and in the last one backward', () => {
    const forward = buildRequest(playing(3600));
    // ceil(3600 * 60 / 32) = 6750 s, clamped by the Moon class to 3600 s.
    expect(forward.step_s).toBe(3600);
    expect(forward.n).toBe(32);
    expect(forward.tt).toBeCloseTo(alignTt0(TT, 3600) - 3600 / DAY_S, 12);
    expect(TT).toBeGreaterThanOrEqual(forward.tt + 3600 / DAY_S);
    expect(TT).toBeLessThan(forward.tt + (2 * 3600) / DAY_S);

    const backward = buildRequest(playing(-3600));
    expect(backward.step_s).toBe(3600);
    expect(backward.tt).toBeCloseTo(alignTt0(TT, 3600) - (30 * 3600) / DAY_S, 12);
    const end = backward.tt + (31 * 3600) / DAY_S;
    expect(TT).toBeGreaterThanOrEqual(end - 3600 / DAY_S);
    expect(TT).toBeLessThan(end);
  });

  it('clamps the step through the smallest class among the requested bodies', () => {
    expect(buildRequest(playing(3600, { bodyIds: MOON_BODIES })).step_s).toBe(6750);
    expect(buildRequest(playing(86400, { bodyIds: MOON_BODIES })).step_s).toBe(21600);
    expect(buildRequest(playing(86400, { bodyIds: ['sun', 'jupiter'] })).step_s).toBe(86400);
    expect(buildRequest(playing(86400, { bodyIds: ['sun', 'jupiter'] })).n).toBe(32);
    // A minor body adds the `minor` class and the joined id list.
    const withMinor = buildRequest(playing(1e6, { bodyIds: ['sun'], minor: ['c:1P', 'a:1'] }));
    expect(withMinor.step_s).toBe(86400);
    expect(withMinor.minor).toBe('c:1P,a:1');
    expect(() => buildRequest(sim({ bodyIds: ['vulcan'] }))).toThrow(RangeError);
  });

  it('switches to snapshot mode when the clamped window covers under 5 s of real time', () => {
    // Moon at 86400x: 31 * 3600 s / 86400 = 1.3 s of real time (brief l.70).
    const snapshot = buildRequest(playing(86400));
    expect(snapshot.n).toBe(1);
    expect(snapshot.step_s).toBe(3600);
    expect(snapshot.tt).toBe(alignTt0(TT, 3600));
    // 31 * 3600 / 20000 = 5.6 s stays a window, 25000x (4.5 s) does not.
    expect(buildRequest(playing(20000)).n).toBe(32);
    expect(buildRequest(playing(25000)).n).toBe(1);
    expect(buildRequest(playing(-25000)).tt).toBe(alignTt0(TT, 3600));
  });

  it('wraps and rounds every observer field', () => {
    const south = buildRequest(
      sim({ observer: { body: 'mars', lat: -33.8688, lon: 180, elev: -3.4 } }),
    );
    expect(south).toMatchObject({ body: 'mars', lat: -33.87, lon: -180, elev: -3 });
    expect(buildRequest(sim({ observer: { ...OBSERVER, lon: 359.996 } })).lon).toBe(0);
    expect(buildRequest(sim({ observer: { ...OBSERVER, lon: -179.996 } })).lon).toBe(-180);
  });
});

describe('requestKey', () => {
  it('is the canonical sorted query, independent of insertion order', () => {
    const a: FrameQuery = {
      tt: 1,
      lat: 2,
      lon: 3,
      n: 32,
      step_s: 60,
      bodies: 'all',
      body: 'earth',
      elev: 0,
    };
    const b: FrameQuery = {
      body: 'earth',
      bodies: 'all',
      elev: 0,
      lat: 2,
      lon: 3,
      n: 32,
      step_s: 60,
      tt: 1,
    };
    expect(requestKey(a)).toBe('bodies=all&body=earth&elev=0&lat=2&lon=3&n=32&step_s=60&tt=1');
    expect(requestKey(b)).toBe(requestKey(a));
    expect(requestKey({ ...a, minor: 'a:1,c:1P' })).toContain('&minor=a:1,c:1P&');
    expect(requestKey(buildRequest(sim()))).toBe(requestKey(buildRequest(sim())));
  });
});

/** A valid response for a request, with placeholder values (the policy never looks at them). */
function syntheticResponse(request: FrameQuery, bodyIds: readonly string[]): FrameResponse {
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
      warnings: [],
    },
    horizon: { q: rows(() => [0, 0, 0, 1]) },
    equinox_of_date: { q: rows(() => [0, 0, 0, 1]) },
    observer_velocity_au_d: rows(() => [0, 0.017, 0]),
    sun_dir: rows(() => [1, 0, 0]),
    bodies: bodyIds.map((id) => ({
      id,
      kind: 'planet',
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

function windowFor(s: SimInput, request = buildRequest(s)): FrameWindow {
  return windowFromResponse(syntheticResponse(request, s.bodyIds), request, effectiveSpeed(s));
}

function stateWith(patch: Partial<FetchState> = {}): FetchState {
  return {
    current: null,
    next: null,
    inFlight: null,
    lastSnapshotDoneMs: -Infinity,
    failedKey: null,
    failedShape: null,
    ...patch,
  };
}

/** A pending request shaped for `speed` (the 60x fixtures by default). */
function inFlightOf(request: FrameQuery, speed = 60): FetchState['inFlight'] {
  return { request, key: requestKey(request), startedMs: 0, speed };
}

describe('decide', () => {
  // A 60x window: step ceil(60 * 60 / 32) = 113 s, tt0 one step before the aligned time.
  const s60 = playing(60);
  const w60 = windowFor(s60);
  const span60 = (w60.n - 1) * w60.stepD;

  it('fetches the initial window and then waits for it', () => {
    const d = decide(stateWith(), s60, 0);
    expect(d).toEqual({
      mode: 'window',
      fetch: buildRequest(s60),
      reason: 'initial',
      swapToNext: false,
      dropNext: false,
      extrapolating: false,
    });
    const waiting = decide(stateWith({ inFlight: inFlightOf(buildRequest(s60)) }), s60, 0);
    expect(waiting.fetch).toBeNull();
    expect(waiting.reason).toBeNull();
  });

  it('never re-issues the failed shape until the simulation changes', () => {
    const failed = stateWith({ failedKey: requestKey(buildRequest(s60)) });
    expect(decide(failed, s60, 0).fetch).toBeNull();
    expect(decide(failed, playing(60, { tt: TT + 1 }), 0).fetch).not.toBeNull();
  });

  it('never issues a shape refused for good, however the time moves, until the shape changes', () => {
    const refused = stateWith({ failedShape: shapeKey(buildRequest(s60)) });
    expect(decide(refused, s60, 0).fetch).toBeNull();
    expect(decide(refused, playing(60, { tt: TT + 1 }), 0).fetch).toBeNull();
    expect(decide(refused, playing(60, { tt: TT - 100 }), 0).fetch).toBeNull();
    const elsewhere = playing(60, { observer: { ...OBSERVER, lat: 52.5 } });
    expect(decide(refused, elsewhere, 0).fetch).not.toBeNull();
    expect(decide(refused, playing(600), 0).fetch).not.toBeNull();
    expect(decide(refused, playing(60, { minor: ['a:1'] }), 0).fetch).not.toBeNull();
  });

  it('waits for a pending request of the same shape while the aligned tt0 moves on', () => {
    // Live mode: 2 s steps, so the exact key the simulation would issue moves every 2 s of wall
    // time while the first request is still pending (a slow link, the client's own 429 retry).
    const live = sim({ mode: 'live' });
    const first = buildRequest(live);
    const pending = stateWith({ inFlight: inFlightOf(first, 1) });
    const later = sim({ mode: 'live', tt: TT + 2.5 / DAY_S });
    expect(requestKey(buildRequest(later))).not.toBe(requestKey(first));
    expect(decide(pending, later, 0)).toMatchObject({ fetch: null, reason: null });
    // Paused counts as forward and never invalidates: the same request is awaited.
    expect(decide(pending, sim({ tt: TT + 2.5 / DAY_S }), 0).fetch).toBeNull();

    // The same under an invalidation of `current`: the pending request already carries the new
    // observer, so it is awaited and only `next` (a day ahead, so no swap hides the drop) is
    // dropped.
    const moved = { ...OBSERVER, lat: 52.5 };
    const movedRequest = buildRequest(playing(60, { observer: moved }));
    const invalidated = decide(
      stateWith({
        current: w60,
        next: windowFor(playing(60, { tt: TT + 1 })),
        inFlight: inFlightOf(movedRequest),
      }),
      playing(60, { observer: moved, tt: TT + 200 / DAY_S }),
      0,
    );
    expect(invalidated.fetch).toBeNull();
    expect(invalidated.dropNext).toBe(true);

    // Whereas a pending request that is not what the simulation wants is replaced: another
    // observer, another body set, a span the time has left, the opposite direction of travel, a
    // speed ratio beyond 10, or the other mode (snapshot against window and back).
    const reasonWith = (inFlight: FetchState['inFlight'], s: SimInput): string | null =>
      decide(stateWith({ inFlight }), s, 0).reason;
    expect(reasonWith(inFlightOf(movedRequest), s60)).toBe('initial');
    expect(reasonWith(inFlightOf(buildRequest(playing(60, { minor: ['a:1'] }))), s60)).toBe(
      'initial',
    );
    expect(reasonWith(inFlightOf(first, 1), sim({ mode: 'live', tt: first.tt + 64 / DAY_S }))).toBe(
      'initial',
    );
    expect(reasonWith(inFlightOf(buildRequest(s60)), sim({ mode: 'playing', speed: -60 }))).toBe(
      'initial',
    );
    expect(reasonWith(inFlightOf(buildRequest(s60)), playing(601))).toBe('initial');
    expect(reasonWith(inFlightOf(buildRequest(s60)), playing(600))).toBeNull();
    const snapRequest = buildRequest(playing(86400));
    expect(snapRequest.n).toBe(1);
    expect(reasonWith(inFlightOf(snapRequest, 86400), s60)).toBe('initial');
    expect(reasonWith(inFlightOf(buildRequest(s60)), playing(86400))).toBe('initial');
    // A pending snapshot is awaited whatever its instant (the snapshot branch does the same).
    expect(
      reasonWith(inFlightOf(snapRequest, 86400), playing(86400, { tt: TT + 7200 / DAY_S })),
    ).toBeNull();
  });

  it('refetches on an observer change beyond the rounding and drops next', () => {
    // A next window a day ahead: it does not cover TT, so no swap hides the drop.
    const elsewhere = windowFor(playing(60, { tt: TT + 1 }));
    const state = stateWith({ current: w60, next: elsewhere });
    const moved = decide(state, playing(60, { observer: { ...OBSERVER, lat: 52.5 } }), 0);
    expect(moved.reason).toBe('observer');
    expect(moved.fetch?.lat).toBe(52.5);
    expect(moved.dropNext).toBe(true);
    // 51.4779 and 51.4801 both round to 51.48: the same request, no fetch (OBS-7 sharing).
    const same = decide(state, playing(60, { observer: { ...OBSERVER, lat: 51.4801 } }), 0);
    expect(same.fetch).toBeNull();
    expect(same.dropNext).toBe(false);
  });

  it('refetches when the body set changes', () => {
    const d = decide(stateWith({ current: w60 }), playing(60, { minor: ['a:1'] }), 0);
    expect(d.reason).toBe('bodies');
    expect(d.fetch?.minor).toBe('a:1');
  });

  it('refetches on a sign change or a speed ratio beyond 10, and pausing keeps the buffer', () => {
    const inside = w60.tt0 + 5 * w60.stepD;
    const state = stateWith({ current: w60 });
    const reasonFor = (speed: number, mode: SimInput['mode'] = 'playing'): string | null =>
      decide(state, sim({ speed, mode, tt: inside }), 0).reason;
    expect(reasonFor(600)).toBeNull(); // ratio 10 is not beyond 10
    expect(reasonFor(601)).toBe('speed');
    expect(reasonFor(6)).toBeNull();
    expect(reasonFor(5)).toBe('speed');
    expect(reasonFor(-60)).toBe('speed');
    expect(reasonFor(-1)).toBe('speed');
    expect(reasonFor(0, 'paused')).toBeNull();
    expect(decide(state, sim({ tt: inside }), 0).extrapolating).toBe(false);

    // A window fetched while paused counts as 1x: resuming at 1x, live or 10x keeps it.
    const paused = windowFor(sim());
    const pausedState = stateWith({ current: paused });
    const tt = paused.tt0 + 3 * paused.stepD;
    expect(decide(pausedState, playing(1, { tt }), 0).reason).toBeNull();
    expect(decide(pausedState, sim({ mode: 'live', tt }), 0).reason).toBeNull();
    expect(decide(pausedState, playing(10, { tt }), 0).reason).toBeNull();
    expect(decide(pausedState, playing(11, { tt }), 0).reason).toBe('speed');
  });

  it('switches between window and snapshot mode on a speed change', () => {
    const toSnapshot = decide(
      stateWith({ current: w60 }),
      playing(86400, { tt: w60.tt0 + w60.stepD }),
      0,
    );
    expect(toSnapshot.mode).toBe('snapshot');
    expect(toSnapshot.reason).toBe('speed');
    expect(toSnapshot.fetch?.n).toBe(1);

    const snap = windowFor(playing(86400));
    const toWindow = decide(stateWith({ current: snap }), playing(60, { tt: snap.tt0 }), 0);
    expect(toWindow.mode).toBe('window');
    expect(toWindow.reason).toBe('speed');
    expect(toWindow.fetch?.n).toBe(32);
  });

  it('refetches on a jump outside every known span, else extrapolates while waiting', () => {
    const far = w60.ttEnd + 1;
    const jump = decide(stateWith({ current: w60 }), playing(60, { tt: far }), 0);
    expect(jump.reason).toBe('jump');
    expect(jump.fetch).toEqual(buildRequest(playing(60, { tt: far })));
    expect(jump.dropNext).toBe(false);
    expect(jump.extrapolating).toBe(true);

    const withNext = decide(stateWith({ current: w60, next: w60 }), playing(60, { tt: far }), 0);
    expect(withNext.reason).toBe('jump');
    expect(withNext.dropNext).toBe(true);

    // The in-flight prefetch covers `tt`: no new request, extrapolate until it lands.
    const prefetch: FrameQuery = { ...w60.request, tt: w60.ttEnd };
    const justPast = w60.ttEnd + 0.5 * w60.stepD;
    const waiting = decide(
      stateWith({ current: w60, inFlight: inFlightOf(prefetch) }),
      playing(60, { tt: justPast }),
      0,
    );
    expect(waiting.fetch).toBeNull();
    expect(waiting.extrapolating).toBe(true);

    // A hand-built in-flight query without `n`/`step_s` spans the API defaults (32 x 60 s).
    const bare: FrameQuery = {
      body: 'earth',
      lat: 51.48,
      lon: 0,
      elev: 46,
      tt: w60.ttEnd,
      bodies: 'all',
    };
    const covered = decide(
      stateWith({ current: w60, inFlight: inFlightOf(bare) }),
      playing(60, { tt: w60.ttEnd + (20 * 60) / DAY_S }),
      0,
    );
    expect(covered.fetch).toBeNull();
    const uncovered = decide(
      stateWith({ current: w60, inFlight: inFlightOf(bare) }),
      playing(60, { tt: w60.ttEnd + (40 * 60) / DAY_S }),
      0,
    );
    expect(uncovered.reason).toBe('jump');
  });

  it('prefetches the next window at 70 % consumption in the direction of travel', () => {
    const before = decide(
      stateWith({ current: w60 }),
      playing(60, { tt: w60.tt0 + 0.69 * span60 }),
      0,
    );
    expect(before.fetch).toBeNull();
    const at70 = decide(
      stateWith({ current: w60 }),
      playing(60, { tt: w60.tt0 + (PREFETCH_FRACTION + 1e-6) * span60 }),
      0,
    );
    expect(at70.reason).toBe('prefetch');
    if (at70.fetch === null) {
      throw new Error('expected a prefetch');
    }
    expect(at70.fetch.tt).toBeCloseTo(w60.ttEnd, 12);
    expect(at70.fetch.n).toBe(32);
    expect(at70.fetch.step_s).toBe(113);
    expect(at70.dropNext).toBe(false);
    expect(at70.extrapolating).toBe(false);
    // Not while the next window (the continuation of `current`, which `tt` has not reached, so
    // no swap empties the slot) exists or a request is in flight.
    const tt = w60.tt0 + 0.9 * span60;
    const next60 = windowFor(s60, at70.fetch);
    expect(next60.tt0).toBeCloseTo(w60.ttEnd, 12);
    expect(
      decide(stateWith({ current: w60, next: next60 }), playing(60, { tt }), 0).fetch,
    ).toBeNull();
    expect(
      decide(stateWith({ current: w60, inFlight: inFlightOf(w60.request) }), playing(60, { tt }), 0)
        .fetch,
    ).toBeNull();

    // Backward: consumption is measured from the end and the next window ends at tt0.
    const back = windowFor(playing(-60));
    const span = (back.n - 1) * back.stepD;
    expect(
      decide(stateWith({ current: back }), playing(-60, { tt: back.ttEnd - 0.6 * span }), 0).fetch,
    ).toBeNull();
    const backPrefetch = decide(
      stateWith({ current: back }),
      playing(-60, { tt: back.ttEnd - 0.71 * span }),
      0,
    );
    expect(backPrefetch.reason).toBe('prefetch');
    expect(backPrefetch.fetch?.tt).toBeCloseTo(back.tt0 - 31 * back.stepD, 12);
  });

  it('never prefetches while paused: a still clock consumes nothing (brief l.69)', () => {
    // Pausing right after a backward fetch leaves `tt` near `ttEnd`, which a forward measure
    // would read as 90 % consumed: no continuation is requested in either direction, and a
    // forward window paused near its end is left alone too. Resuming prefetches at once.
    const back = windowFor(playing(-60));
    const spanBack = (back.n - 1) * back.stepD;
    expect(
      decide(stateWith({ current: back }), sim({ tt: back.tt0 + 0.9 * spanBack }), 0).fetch,
    ).toBeNull();
    const nearEnd = w60.tt0 + 0.9 * span60;
    const paused = decide(stateWith({ current: w60 }), sim({ tt: nearEnd }), 0);
    expect(paused.fetch).toBeNull();
    expect(paused.extrapolating).toBe(false);
    expect(decide(stateWith({ current: w60 }), playing(60, { tt: nearEnd }), 0).reason).toBe(
      'prefetch',
    );
  });

  it('promotes next when tt enters it and keeps prefetching from the new current', () => {
    const prefetch = decide(
      stateWith({ current: w60 }),
      playing(60, { tt: w60.tt0 + 0.75 * span60 }),
      0,
    );
    if (prefetch.fetch === null) {
      throw new Error('expected a prefetch');
    }
    const next = windowFor(s60, prefetch.fetch);
    expect(next.tt0).toBeCloseTo(w60.ttEnd, 12);
    const state = stateWith({ current: w60, next });
    const entered = decide(state, playing(60, { tt: next.tt0 + 0.75 * span60 }), 0);
    expect(entered.swapToNext).toBe(true);
    expect(entered.dropNext).toBe(false);
    expect(entered.extrapolating).toBe(false);
    expect(entered.reason).toBe('prefetch');
    expect(entered.fetch?.tt).toBeCloseTo(next.ttEnd, 12);
    // Still inside current: no swap, and next already exists.
    const stay = decide(state, playing(60, { tt: w60.tt0 + 0.9 * span60 }), 0);
    expect(stay.swapToNext).toBe(false);
    expect(stay.fetch).toBeNull();
  });

  it('refetches snapshots at most every 250 ms with the 1e-8 day tolerance', () => {
    const fast = playing(86400);
    const snap = windowFor(fast);
    expect(snap.n).toBe(1);
    const state = stateWith({ current: snap, lastSnapshotDoneMs: 0 });
    // Same aligned sample: nothing to fetch, and a snapshot never reports extrapolation.
    const same = decide(state, fast, 1000);
    expect(same).toMatchObject({ mode: 'snapshot', fetch: null, extrapolating: false });

    const later = playing(86400, { tt: TT + 3600 / DAY_S });
    const due = decide(state, later, SNAPSHOT_MIN_INTERVAL_MS);
    expect(due.reason).toBe('snapshot');
    expect(due.fetch?.n).toBe(1);
    expect(due.fetch?.tt).toBe(alignTt0(later.tt, 3600));
    expect(decide(state, later, SNAPSHOT_MIN_INTERVAL_MS - 1).fetch).toBeNull();
    expect(
      decide(stateWith({ ...state, inFlight: inFlightOf(w60.request) }), later, 1000).fetch,
    ).toBeNull();
    expect(
      decide(stateWith({ ...state, failedKey: requestKey(buildRequest(later)) }), later, 1000)
        .fetch,
    ).toBeNull();

    const within = { ...snap, tt0: snap.tt0 + 5e-9 };
    expect(
      decide(stateWith({ current: within, lastSnapshotDoneMs: 0 }), fast, 1000).fetch,
    ).toBeNull();
    const beyond = { ...snap, tt0: snap.tt0 + 2e-8 };
    expect(decide(stateWith({ current: beyond, lastSnapshotDoneMs: 0 }), fast, 1000).reason).toBe(
      'snapshot',
    );
  });
});

describe('shapeKey', () => {
  it('drops tt and keeps everything that shapes the request', () => {
    const a = buildRequest(playing(60));
    const b = buildRequest(playing(60, { tt: TT + 1 }));
    expect(requestKey(a)).not.toBe(requestKey(b));
    expect(shapeKey(a)).toBe(shapeKey(b));
    expect(shapeKey(a)).not.toContain('tt=');
    // `tt` sorts last: the shape is the canonical key without its final pair.
    expect(shapeKey(a)).toBe(requestKey(a).replace(/&tt=[^&]*$/, ''));
    expect(shapeKey(a)).not.toBe(shapeKey(buildRequest(playing(600))));
    expect(shapeKey(a)).not.toBe(shapeKey(buildRequest(playing(86400))));
    expect(shapeKey(a)).not.toBe(
      shapeKey(buildRequest(playing(60, { observer: { ...OBSERVER, lat: 52.5 } }))),
    );
    expect(shapeKey(a)).not.toBe(shapeKey(buildRequest(playing(60, { minor: ['a:1'] }))));
  });
});

describe('coverage bound', () => {
  // The live de440s bounds: not on the API's 1e-8 day grid (frames.ts COVERAGE_GUARD_D).
  const range: [number, number] = [2396753.500000002, 2506351.499999995];
  const lo = range[0] + COVERAGE_GUARD_D / 2;
  const hi = range[1] - COVERAGE_GUARD_D / 2;

  function spanOf(request: FrameQuery): number {
    return (((request.n ?? 32) - 1) * (request.step_s ?? 60)) / DAY_S;
  }

  it('stops the clock one guard inside the bound', () => {
    expect(clampInsideCoverage(TT, range)).toBe(TT);
    expect(clampInsideCoverage(range[1] + 10, range)).toBe(range[1] - COVERAGE_GUARD_D);
    expect(clampInsideCoverage(range[1], range)).toBe(range[1] - COVERAGE_GUARD_D);
    expect(clampInsideCoverage(range[0], range)).toBe(range[0] + COVERAGE_GUARD_D);
    expect(clampInsideCoverage(range[0] - 10, range)).toBe(range[0] + COVERAGE_GUARD_D);
  });

  it('shifts a window flush inside the bound it left, still covering the stopped clock', () => {
    // Every time the engine can hand over around the upper bound, in every placement: paused,
    // live, forward and backward.
    const shapes = (tt: number): SimInput[] => [
      sim({ tt }),
      sim({ mode: 'live', tt }),
      playing(60, { tt }),
      sim({ mode: 'playing', speed: -60, tt }),
    ];
    let shifted = 0;
    for (const tt of [range[1] + 3, range[1], range[1] - 5 / DAY_S, range[1] - 40 / DAY_S]) {
      for (const s of shapes(tt)) {
        const request = buildRequest(s);
        const bounded = boundedRequest(request, range);
        if (request.tt + spanOf(request) <= hi) {
          expect(bounded).toBeNull();
          continue;
        }
        if (bounded === null) {
          throw new Error('expected a shifted request');
        }
        shifted += 1;
        expect(bounded).toEqual({ ...request, tt: hi - spanOf(request) });
        const stopped = clampInsideCoverage(tt, range);
        expect(stopped).toBeGreaterThanOrEqual(bounded.tt);
        expect(stopped).toBeLessThanOrEqual(bounded.tt + spanOf(bounded));
      }
    }
    // The paused 1 s window at 40 s before the end is the one that already fits.
    expect(shifted).toBe(15);

    shifted = 0;
    for (const tt of [range[0] - 3, range[0], range[0] + 0.5 / DAY_S, range[0] + 1]) {
      for (const s of shapes(tt)) {
        const request = buildRequest(s);
        const bounded = boundedRequest(request, range);
        if (request.tt >= lo) {
          expect(bounded).toBeNull();
          continue;
        }
        if (bounded === null) {
          throw new Error('expected a shifted request');
        }
        shifted += 1;
        expect(bounded).toEqual({ ...request, tt: lo });
        const stopped = clampInsideCoverage(tt, range);
        expect(stopped).toBeGreaterThanOrEqual(lo);
        expect(stopped).toBeLessThanOrEqual(lo + spanOf(bounded));
      }
    }
    // A day after the start every placement fits.
    expect(shifted).toBe(12);

    // A request inside the range is not the cause of the refusal.
    expect(boundedRequest(buildRequest(playing(60)), range)).toBeNull();
    // A snapshot lands on the guarded bound.
    const snap: FrameQuery = { ...buildRequest(playing(86400)), tt: range[1] };
    expect(snap.n).toBe(1);
    expect(boundedRequest(snap, range)).toEqual({ ...snap, tt: hi });
  });
});

describe('consumed and windowCovers', () => {
  const w = windowFor(playing(60));
  const span = (w.n - 1) * w.stepD;

  it('measures consumption in the direction of travel', () => {
    expect(consumed(w, w.tt0, 60)).toBe(0);
    // Resolution: 5e-10 day on tt over a 0.04 day span is about 1e-8 of consumption.
    expect(consumed(w, w.tt0 + 0.25 * span, 60)).toBeCloseTo(0.25, 7);
    expect(consumed(w, w.ttEnd, 60)).toBeCloseTo(1, 7);
    expect(consumed(w, w.ttEnd, -60)).toBe(0);
    expect(consumed(w, w.tt0 + 0.25 * span, -60)).toBeCloseTo(0.75, 7);
    expect(consumed(w, w.tt0, 0)).toBe(0); // paused counts as forward
    expect(consumed(windowFor(playing(86400)), TT, 86400)).toBe(1);
  });

  it('covers the closed sample span', () => {
    expect(windowCovers(w, w.tt0)).toBe(true);
    expect(windowCovers(w, w.ttEnd)).toBe(true);
    expect(windowCovers(w, w.tt0 - 1e-9)).toBe(false);
    expect(windowCovers(w, w.ttEnd + 1e-9)).toBe(false);
  });
});

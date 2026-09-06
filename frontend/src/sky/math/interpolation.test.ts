// @vitest-environment node
// Interpolation parity (plan D74, D88; brief l.68, l.181, l.263): Hermite from every second
// sample of the three `skyfield_frames.json` windows reproduces the skipped samples within the
// contractual 60 arcsec and a 1 arcsec regression bound (measured 0.26), the scalar channels
// (distance and diameter to 2e-6 relative; magnitude to 1e-3 and phase to 1e-5 absolute, see the
// scalar test for why a relative bound fails near new Moon), plus the synthetic cases (NaN
// magnitudes, one-sided ends, LST wrap, extrapolation, snapshot windows).

import { loadFramesFixture } from '../../test/fixtures';
import {
  catmullRomTangent,
  extrapolateDir,
  extrapolateQuat,
  extrapolateScalar,
  hermite,
  interpolateDir,
  interpolateLstHours,
  interpolateScalar,
  interpolateVec3,
  sampleTt,
  segmentFraction,
  segmentIndex,
  slerpAt,
} from './interpolation';
import { fromAxisAngle, multiplyQ, rotationAngle, slerp } from './quaternion';
import type { Quat, Vec3 } from './typed';
import { quat, vec3 } from './typed';
import { ARCSEC_PER_RAD, arcsecBetween3, length3, normalize3, sub3 } from './vec3';

const frames = loadFramesFixture();

function flatten(rows: readonly (readonly number[])[]): Float64Array {
  return Float64Array.from(rows.flat());
}

/** Every second sample of a channel: the grid the interpolation is tested from. */
function everySecond(values: ArrayLike<number>, n: number, width: number): Float64Array {
  const m = Math.ceil(n / 2);
  const out = new Float64Array(m * width);
  for (let k = 0; k < m; k += 1) {
    for (let c = 0; c < width; c += 1) {
      out[k * width + c] = values[2 * k * width + c] ?? NaN;
    }
  }
  return out;
}

describe('grid helpers', () => {
  it('sampleTt, segmentIndex and segmentFraction on the echoed grid', () => {
    const tt0 = 2460409.25;
    const stepD = 300 / 86400;
    expect(sampleTt(tt0, stepD, 3)).toBeCloseTo(tt0 + 900 / 86400, 12);
    expect(segmentIndex(tt0, stepD, 32, tt0)).toBe(0);
    expect(segmentIndex(tt0, stepD, 32, tt0 + 2.5 * stepD)).toBe(2);
    expect(segmentIndex(tt0, stepD, 32, tt0 - 5 * stepD)).toBe(0);
    expect(segmentIndex(tt0, stepD, 32, tt0 + 40 * stepD)).toBe(30);
    expect(segmentIndex(tt0, stepD, 32, tt0 + 31 * stepD)).toBe(30);
    expect(segmentIndex(tt0, stepD, 1, tt0 + 7)).toBe(0);
    // tt is about 2.46e6 days: float64 resolves it to 5e-10 day, 1.3e-7 of a 300 s step.
    expect(segmentFraction(tt0, stepD, 2, tt0 + 2.5 * stepD)).toBeCloseTo(0.5, 6);
    expect(segmentFraction(tt0, stepD, 0, tt0 - stepD)).toBeCloseTo(-1, 6);
  });

  it('hermite reproduces its endpoints and tangents', () => {
    expect(hermite(1, 5, 0.3, -0.7, 0)).toBe(1);
    expect(hermite(1, 5, 0.3, -0.7, 1)).toBe(5);
    const h = 1e-6;
    expect((hermite(1, 5, 0.3, -0.7, h) - 1) / h).toBeCloseTo(0.3, 4);
    expect((5 - hermite(1, 5, 0.3, -0.7, 1 - h)) / h).toBeCloseTo(-0.7, 4);
    // A straight line is reproduced exactly with its slope as tangent.
    expect(hermite(2, 4, 2, 2, 0.25)).toBeCloseTo(2.5, 15);
  });
});

describe('catmullRomTangent', () => {
  const y = [1, 2, 4, 8, 16];

  it('is centred inside and one-sided at both ends', () => {
    expect(catmullRomTangent(y, 5, 2, 1, 0)).toBe((8 - 2) / 2);
    expect(catmullRomTangent(y, 5, 0, 1, 0)).toBe(1);
    expect(catmullRomTangent(y, 5, 4, 1, 0)).toBe(8);
  });

  it('reads strided channels', () => {
    const interleaved = [1, 100, 2, 200, 4, 400];
    expect(catmullRomTangent(interleaved, 3, 1, 2, 1)).toBe((400 - 100) / 2);
    expect(catmullRomTangent(interleaved, 3, 1, 2, 0)).toBe((4 - 1) / 2);
  });

  it('falls back to one-sided next to a NaN neighbour and to 0 with none', () => {
    const withNaN = [1, NaN, 4, 8, NaN];
    expect(catmullRomTangent(withNaN, 5, 2, 1, 0)).toBe(8 - 4);
    expect(catmullRomTangent(withNaN, 5, 3, 1, 0)).toBe(8 - 4);
    expect(catmullRomTangent(withNaN, 5, 0, 1, 0)).toBe(0);
    expect(catmullRomTangent([NaN, 1, NaN], 3, 1, 1, 0)).toBe(0);
    expect(catmullRomTangent([7], 1, 0, 1, 0)).toBe(0);
  });
});

describe('interpolateScalar', () => {
  it('propagates NaN endpoints (mag: null) and keeps finite segments finite', () => {
    const mag = [1, NaN, 3, 4];
    expect(interpolateScalar(mag, 4, 0, 0.5)).toBeNaN();
    expect(interpolateScalar(mag, 4, 1, 0.5)).toBeNaN();
    expect(interpolateScalar(mag, 4, 0, 0)).toBeNaN();
    const finite = interpolateScalar(mag, 4, 2, 0.5, 1, 0);
    expect(Number.isFinite(finite)).toBe(true);
    expect(finite).toBeCloseTo(3.5, 12);
  });

  it('returns the only sample of a snapshot window and reads strides', () => {
    expect(interpolateScalar([42], 1, 0, 0.7)).toBe(42);
    expect(interpolateScalar([1, 10, 2, 20, 3, 30], 3, 1, 0.5, 2, 1)).toBeCloseTo(25, 12);
  });
});

describe('parity with skyfield_frames.json (from every second sample)', () => {
  it('Hermite body directions within 60 arcsec contractual and 1 arcsec regression', () => {
    // Measured 2026-09-06: 0.253 arcsec (the Moon from Greenwich, 600 s effective step).
    let worst = 0;
    for (const w of frames.windows) {
      const m = Math.ceil(w.n / 2);
      for (const body of Object.values(w.bodies)) {
        const full = flatten(body.dir);
        const coarse = everySecond(full, w.n, 3);
        for (let k = 0; k + 1 < m; k += 1) {
          const skipped: Vec3 = [
            full[3 * (2 * k + 1)] ?? NaN,
            full[3 * (2 * k + 1) + 1] ?? NaN,
            full[3 * (2 * k + 1) + 2] ?? NaN,
          ];
          const p = interpolateDir(vec3(), coarse, m, k, 0.5);
          expect(length3(p)).toBeCloseTo(1, 14);
          worst = Math.max(worst, arcsecBetween3(p, skipped));
        }
      }
    }
    expect(worst).toBeLessThanOrEqual(60);
    expect(worst).toBeLessThanOrEqual(1);
  });

  it('Hermite scalar channels: distance and diameter to 2e-6 relative, mag to 1e-3, phase to 1e-5', () => {
    // Measured 2026-09-06 (from every second sample, i.e. 600 s / 7200 s steps): dist_au 1.1e-6
    // and diam_deg 1.2e-6 relative (Earth seen from the Moon), mag 2.5e-4 absolute (the Moon,
    // whose magnitude law has a cusp near new Moon) and phase 1.2e-7 absolute (the Moon at an
    // illuminated fraction of 1.3e-5, where a relative bound is meaningless; worst absolute
    // 5.0e-6). All far below the display resolution (0.01 mag, 0.1 % phase).
    let worstRelative = 0;
    let worstMag = 0;
    let worstPhase = 0;
    for (const w of frames.windows) {
      const m = Math.ceil(w.n / 2);
      for (const body of Object.values(w.bodies)) {
        for (const channel of [body.dist_au, body.diam_deg]) {
          const coarse = everySecond(channel, w.n, 1);
          for (let k = 0; k + 1 < m; k += 1) {
            const skipped = channel[2 * k + 1] ?? NaN;
            const v = interpolateScalar(coarse, m, k, 0.5);
            worstRelative = Math.max(worstRelative, Math.abs(v - skipped) / Math.abs(skipped));
          }
        }
        const mag = everySecond(body.mag, w.n, 1);
        const phase = everySecond(body.phase, w.n, 1);
        for (let k = 0; k + 1 < m; k += 1) {
          worstMag = Math.max(
            worstMag,
            Math.abs(interpolateScalar(mag, m, k, 0.5) - (body.mag[2 * k + 1] ?? NaN)),
          );
          worstPhase = Math.max(
            worstPhase,
            Math.abs(interpolateScalar(phase, m, k, 0.5) - (body.phase[2 * k + 1] ?? NaN)),
          );
        }
      }
    }
    expect(worstRelative).toBeLessThanOrEqual(2e-6);
    expect(worstMag).toBeLessThanOrEqual(1e-3);
    expect(worstPhase).toBeLessThanOrEqual(1e-5);
  });

  it('slerpAt and linear sun_dir / velocity reproduce the skipped samples', () => {
    for (const w of frames.windows) {
      const m = Math.ceil(w.n / 2);
      const q = everySecond(flatten(w.horizon_q), w.n, 4);
      const sun = everySecond(flatten(w.sun_dir), w.n, 3);
      const vel = everySecond(flatten(w.observer_velocity_au_d), w.n, 3);
      for (let k = 0; k + 1 < m; k += 1) {
        const midQ = w.horizon_q[2 * k + 1];
        const midSun = w.sun_dir[2 * k + 1];
        const midVel = w.observer_velocity_au_d[2 * k + 1];
        if (midQ === undefined || midSun === undefined || midVel === undefined) {
          throw new Error('missing sample');
        }
        const sq = slerpAt(quat(), q, m, k, 0.5);
        expect(rotationAngle(sq, midQ) * ARCSEC_PER_RAD).toBeLessThanOrEqual(0.01);
        const s = interpolateVec3(vec3(), sun, m, k, 0.5, true);
        expect(length3(s)).toBeCloseTo(1, 14);
        expect(arcsecBetween3(s, midSun)).toBeLessThanOrEqual(1);
        // Linear over a doubled step (up to 7200 s of Mars rotation): measured 2.8e-4 relative,
        // i.e. 0.006 arcsec of aberration (20 arcsec * 2.8e-4).
        const v = interpolateVec3(vec3(), vel, m, k, 0.5, false);
        expect(length3(sub3(vec3(), v, midVel)) / length3(midVel)).toBeLessThan(1e-3);
      }
    }
  });

  it('slerpAt renormalises the rounded samples and matches slerp on them', () => {
    const w = frames.windows[0];
    if (w === undefined) {
      throw new Error('no window');
    }
    const q = flatten(w.equinox_q);
    const a = w.equinox_q[3];
    const b = w.equinox_q[4];
    if (a === undefined || b === undefined) {
      throw new Error('missing sample');
    }
    const na = normalizeQuat(a);
    const nb = normalizeQuat(b);
    const viaAt = slerpAt(quat(), q, w.n, 3, 0.3);
    expect(rotationAngle(viaAt, slerp(quat(), na, nb, 0.3))).toBeLessThan(1e-14);
    expect(Math.hypot(...viaAt)).toBeCloseTo(1, 15);
    const first = w.equinox_q[0];
    if (first === undefined) {
      throw new Error('missing sample');
    }
    const snapshot = slerpAt(quat(), q, 1, 0, 0.9);
    expect(rotationAngle(snapshot, normalizeQuat(first))).toBeLessThan(1e-14);
    expect(Math.hypot(...snapshot)).toBeCloseTo(1, 15);
  });
});

function normalizeQuat(q: Quat): Quat {
  const len = Math.hypot(q[0], q[1], q[2], q[3]);
  return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
}

describe('interpolateDir / interpolateVec3 on snapshot windows', () => {
  it('hold their only sample, renormalised where a direction is expected', () => {
    const dirs = [0, 0, 2];
    expect(interpolateDir(vec3(), dirs, 1, 0, 0.5)).toEqual([0, 0, 1]);
    expect(interpolateVec3(vec3(), dirs, 1, 0, 0.5, true)).toEqual([0, 0, 1]);
    expect(interpolateVec3(vec3(), dirs, 1, 0, 0.5, false)).toEqual([0, 0, 2]);
  });

  it('interpolateVec3 is linear between samples with and without renormalisation', () => {
    const values = [1, 0, 0, 0, 1, 0];
    const raw = interpolateVec3(vec3(), values, 2, 0, 0.5, false);
    expect(raw).toEqual([0.5, 0.5, 0]);
    const unit = interpolateVec3(vec3(), values, 2, 0, 0.5, true);
    expect(unit[0]).toBeCloseTo(Math.SQRT1_2, 15);
    expect(unit[1]).toBeCloseTo(Math.SQRT1_2, 15);
    expect(unit[2]).toBe(0);
  });
});

describe('interpolateLstHours', () => {
  it('wraps 23.9 -> 0.1 through 0 in both directions', () => {
    expect(interpolateLstHours([23.9, 0.1], 2, 0, 0.5)).toBeCloseTo(0, 12);
    expect(interpolateLstHours([23.9, 0.1], 2, 0, 0.25)).toBeCloseTo(23.95, 12);
    expect(interpolateLstHours([23.9, 0.1], 2, 0, 0.75)).toBeCloseTo(0.05, 12);
    expect(interpolateLstHours([0.1, 23.9], 2, 0, 0.5)).toBeCloseTo(0, 12);
    expect(interpolateLstHours([0.1, 23.9], 2, 0, 0.25)).toBeCloseTo(0.05, 12);
  });

  it('is plain linear away from the wrap and stays in [0, 24)', () => {
    expect(interpolateLstHours([5, 5.5, 6], 3, 1, 0.5)).toBeCloseTo(5.75, 12);
    expect(interpolateLstHours([23.9, 0.1], 2, 0, 0.5)).toBeGreaterThanOrEqual(0);
    expect(interpolateLstHours([12, 12], 2, 0, 0.5)).toBe(12);
    // Synthetic out-of-range inputs are wrapped too (including the -0 / 24 edge).
    expect(interpolateLstHours([-0.1], 1, 0, 0)).toBeCloseTo(23.9, 12);
    expect(interpolateLstHours([-1e-17], 1, 0, 0)).toBe(0);
    expect(interpolateLstHours([24], 1, 0, 0)).toBe(0);
    expect(interpolateLstHours([7.25], 1, 0, 0.5)).toBe(7.25);
  });
});

describe('extrapolation (brief l.69)', () => {
  const tt0 = 2451545;
  const stepD = 1 / 24;
  const linear = [10, 11, 12, 13];

  it('extrapolateScalar continues a linear channel exactly on both sides', () => {
    expect(extrapolateScalar(linear, 4, stepD, tt0, tt0 + 5 * stepD)).toBeCloseTo(15, 6);
    expect(extrapolateScalar(linear, 4, stepD, tt0, tt0 - 2 * stepD)).toBeCloseTo(8, 6);
    expect(extrapolateScalar(linear, 4, stepD, tt0, tt0 + 1.5 * stepD)).toBeCloseTo(11.5, 6);
    expect(extrapolateScalar([1, 10, 2, 20], 2, stepD, tt0, tt0 + 3 * stepD, 2, 1)).toBeCloseTo(
      40,
      6,
    );
    expect(extrapolateScalar([42], 1, stepD, tt0, tt0 + 9)).toBe(42);
  });

  it('extrapolateDir continues the boundary pair and renormalises', () => {
    const dirs = [1, 0, 0, Math.cos(0.01), Math.sin(0.01), 0];
    const ahead = extrapolateDir(vec3(), dirs, 2, stepD, tt0, tt0 + 3 * stepD);
    expect(length3(ahead)).toBeCloseTo(1, 15);
    expect(Math.atan2(ahead[1], ahead[0])).toBeCloseTo(
      Math.atan((3 * Math.sin(0.01)) / (1 + 3 * (Math.cos(0.01) - 1))),
      12,
    );
    const before = extrapolateDir(vec3(), dirs, 2, stepD, tt0, tt0 - stepD);
    expect(before[1]).toBeLessThan(0);
    expect(extrapolateDir(vec3(), [0, 3, 0], 1, stepD, tt0, tt0 + 5)).toEqual([0, 1, 0]);
  });

  it('extrapolateQuat continues the rotation at constant rate', () => {
    const axis = normalize3(vec3(), [1, 2, 3]);
    const q0 = fromAxisAngle(quat(), axis, 0.2);
    const step = fromAxisAngle(quat(), axis, 0.01);
    const q1 = multiplyQ(quat(), step, q0);
    const q2 = multiplyQ(quat(), step, q1);
    const qs = [...q0, ...q1, ...q2];
    const ahead = extrapolateQuat(quat(), qs, 3, stepD, tt0, tt0 + 4 * stepD);
    expect(rotationAngle(ahead, q0)).toBeCloseTo(0.04, 9);
    expect(rotationAngle(ahead, q2)).toBeCloseTo(0.02, 9);
    const before = extrapolateQuat(quat(), qs, 3, stepD, tt0, tt0 - stepD);
    expect(rotationAngle(before, q0)).toBeCloseTo(0.01, 9);
    expect(rotationAngle(before, q1)).toBeCloseTo(0.02, 9);
    const snapshot = extrapolateQuat(quat(), [0, 0, 0, 2], 1, stepD, tt0, tt0 + 3);
    expect(snapshot).toEqual([0, 0, 0, 1]);
  });
});

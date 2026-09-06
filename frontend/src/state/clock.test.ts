// @vitest-environment node
// Clock arithmetic (plan D75): `tt` derived from a control block and one wall clock; a speed
// must be exact to 0.1 % (brief l.264) and live mode follows `Date.now()` through TT - UTC.

import { DAY_MS, DAY_S, liveTt } from '../sky/math/time';
import { anchored, liveControl, pausedAt, ttAt } from './clock';
import type { ClockControl } from './types';

const T0 = 1_757_000_000_000; // 2025-09-04T14:13:20Z, an arbitrary wall time in ms
const TT_MINUS_UTC = 69.184;

describe('ttAt', () => {
  it('follows the wall clock in live mode', () => {
    const control = liveControl(T0);
    expect(ttAt(control, T0, TT_MINUS_UTC)).toBe(liveTt(T0, TT_MINUS_UTC));
    expect(ttAt(control, T0 + DAY_MS, TT_MINUS_UTC) - ttAt(control, T0, TT_MINUS_UTC)).toBeCloseTo(
      1,
      12,
    );
    // TT - UTC enters as seconds of a day.
    expect(ttAt(control, T0, 0) + TT_MINUS_UTC / DAY_S).toBeCloseTo(
      ttAt(control, T0, TT_MINUS_UTC),
      12,
    );
  });

  it('holds the anchor while paused whatever the wall clock does', () => {
    const control = pausedAt(2460409.25, T0);
    expect(ttAt(control, T0, TT_MINUS_UTC)).toBe(2460409.25);
    expect(ttAt(control, T0 + 3_600_000, TT_MINUS_UTC)).toBe(2460409.25);
  });

  it('advances at the signed speed while playing, exact to far better than 0.1 %', () => {
    const forward: ClockControl = {
      mode: 'playing',
      speed: 3600,
      ttAnchor: 2460409.25,
      wallAnchorMs: T0,
    };
    const afterTenSeconds = ttAt(forward, T0 + 10_000, TT_MINUS_UTC);
    const expectedDays = (3600 * 10) / DAY_S;
    expect(Math.abs(afterTenSeconds - 2460409.25 - expectedDays) / expectedDays).toBeLessThan(1e-9);

    const backward: ClockControl = { ...forward, speed: -86400 };
    expect(ttAt(backward, T0 + 30_000, TT_MINUS_UTC)).toBeCloseTo(2460409.25 - 30, 9);

    const realtime: ClockControl = { ...forward, speed: 1 };
    expect(ttAt(realtime, T0 + DAY_MS, TT_MINUS_UTC)).toBeCloseTo(2460409.25 + 1, 9);
  });
});

describe('anchored', () => {
  it('re-anchors at the current simulation time and applies the patch', () => {
    const playing: ClockControl = {
      mode: 'playing',
      speed: 60,
      ttAnchor: 2460409.25,
      wallAnchorMs: T0,
    };
    const paused = anchored(playing, T0 + 60_000, TT_MINUS_UTC, { mode: 'paused', speed: 0 });
    expect(paused).toEqual({
      mode: 'paused',
      speed: 0,
      ttAnchor: 2460409.25 + 3600 / DAY_S,
      wallAnchorMs: T0 + 60_000,
    });
    // Resuming from the paused block continues where it stopped.
    const resumed = anchored(paused, T0 + 90_000, TT_MINUS_UTC, { mode: 'playing', speed: -60 });
    expect(resumed.ttAnchor).toBe(paused.ttAnchor);
    expect(resumed.speed).toBe(-60);
    expect(resumed.wallAnchorMs).toBe(T0 + 90_000);
  });

  it('keeps mode and speed without a patch', () => {
    const control: ClockControl = { mode: 'playing', speed: 10, ttAnchor: 100, wallAnchorMs: T0 };
    const again = anchored(control, T0 + 1000, TT_MINUS_UTC);
    expect(again.mode).toBe('playing');
    expect(again.speed).toBe(10);
    expect(again.ttAnchor).toBeCloseTo(100 + 10 / DAY_S, 12);
  });

  it('anchors live mode at the wall clock time', () => {
    const paused = anchored(liveControl(T0), T0 + 5000, TT_MINUS_UTC, { mode: 'paused' });
    expect(paused.ttAnchor).toBe(liveTt(T0 + 5000, TT_MINUS_UTC));
  });
});

describe('pausedAt and liveControl', () => {
  it('build the two canonical blocks', () => {
    expect(pausedAt(2451545, T0)).toEqual({
      mode: 'paused',
      speed: 0,
      ttAnchor: 2451545,
      wallAnchorMs: T0,
    });
    const live = liveControl(T0);
    expect(live.mode).toBe('live');
    expect(live.speed).toBe(0);
    expect(live.wallAnchorMs).toBe(T0);
    expect(Number.isNaN(live.ttAnchor)).toBe(true);
  });
});

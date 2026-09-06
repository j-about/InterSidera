// Pure clock arithmetic (plan D75). The engine calls `ttAt` once per animation frame with
// `Date.now()`, the single wall clock of the application (live mode drift <= 100 ms, brief
// l.264; `performance.now()` is used only for frame-rate statistics).

import { DAY_MS, liveTt } from '../sky/math/time';
import type { ClockControl } from './types';

/** The simulation time for a control block at wall time `nowMs`. */
export function ttAt(control: ClockControl, nowMs: number, ttMinusUtcS: number): number {
  switch (control.mode) {
    case 'live':
      return liveTt(nowMs, ttMinusUtcS);
    case 'paused':
      return control.ttAnchor;
    case 'playing':
      return control.ttAnchor + (control.speed * (nowMs - control.wallAnchorMs)) / DAY_MS;
  }
}

/** A control block re-anchored at the current time (used when the speed or mode changes). */
export function anchored(
  control: ClockControl,
  nowMs: number,
  ttMinusUtcS: number,
  patch: Partial<Pick<ClockControl, 'mode' | 'speed'>> = {},
): ClockControl {
  return {
    mode: patch.mode ?? control.mode,
    speed: patch.speed ?? control.speed,
    ttAnchor: ttAt(control, nowMs, ttMinusUtcS),
    wallAnchorMs: nowMs,
  };
}

/** A paused control block at an explicit time. */
export function pausedAt(tt: number, nowMs: number): ClockControl {
  return { mode: 'paused', speed: 0, ttAnchor: tt, wallAnchorMs: nowMs };
}

/** The live control block. */
export function liveControl(nowMs: number): ClockControl {
  return { mode: 'live', speed: 0, ttAnchor: NaN, wallAnchorMs: nowMs };
}

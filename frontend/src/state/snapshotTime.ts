import { isoUtcFromTt } from '../sky/math/time';
import type { ClockState } from './types';

// The instant a PNG export is named after (VIEW-6, plan D112): the rendered, simulated moment
// once the engine has published its mirror, the wall clock before the first frame (the mirror
// is `NaN` until then). Lives outside `ui/` because the TT -> UTC conversion is sky math.

/** `YYYY-MM-DDThh:mm:ssZ` (astronomical year numbering) of the clock's rendered instant. */
export function snapshotIsoUtc(
  clock: Pick<ClockState, 'tt' | 'ttMinusUtc'>,
  nowMs: number,
): string {
  if (Number.isFinite(clock.tt) && Number.isFinite(clock.ttMinusUtc)) {
    return isoUtcFromTt(clock.tt, clock.ttMinusUtc);
  }
  return new Date(nowMs).toISOString();
}

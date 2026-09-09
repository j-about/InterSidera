// Coverage of the simulation time (TIME-2, TIME-4; plan D98, D100): the TT range the clock may
// visit from an observer body is the ephemeris range of `/meta.coverage.ephemeris_tt`
// intersected with that body's `coverage_tt` (its frame kernel), the same intersection the engine
// clamps to (`SkyEngine.updateCoverage`). Pure: it reads `/meta` and returns numbers and signed
// years for the editor, the step buttons and the banners.

import type { MetaResponse } from './storeTypes';
import { formatSignedYear } from './timeDisplay';

export type CoverageRange = readonly [number, number];

/** `ephemeris_tt` intersected with the observer's `coverage_tt`; `null` before `/meta`. */
export function observerCoverage(meta: MetaResponse | null, body: string): CoverageRange | null {
  if (meta === null) {
    return null;
  }
  const ephemeris = meta.coverage.ephemeris_tt;
  let start = ephemeris[0];
  let end = ephemeris[1];
  const observer = meta.observers.find((o) => o.id === body);
  if (observer !== undefined) {
    start = Math.max(start, observer.coverage_tt[0]);
    end = Math.min(end, observer.coverage_tt[1]);
  }
  return [start, end];
}

/** `true` when `tt` lies inside `range` (bounds included). */
export function withinCoverage(tt: number, range: CoverageRange): boolean {
  return tt >= range[0] && tt <= range[1];
}

/** Both bounds as signed calendar years (`-0044`, `2150`) for the texts (brief l.526). */
export function coverageYears(range: CoverageRange): { start: string; end: string } {
  return { start: formatSignedYear(range[0]), end: formatSignedYear(range[1]) };
}

// The one place an object id becomes a direction (plan D94): `hip:<n>` through the star
// catalog, `dso:<id>` (canonical OpenNGC id or a Messier alias `M<n>`) through the DSO catalog,
// a body id or `a:`/`c:` through the evaluated frame window, and `con:<abbr>` through the
// constellation label point (centring only, never a selection). Every direction goes through the
// pure kernels of `sky/math/apparent.ts`, so labels, constellation lines, picking, follow mode,
// the marker, the readout and the debug hook agree with the shaders. Nothing here allocates per
// call: the last parsed id is memoised and the results are written into `out` parameters.

import type { CatalogBundle, ConstellationEntry, DsoEntry } from '../../api/catalogs';
import type { FrameEval, SelectionReadout } from '../../state/types';
import { enuFromApparentIcrf } from '../math/apparent';
import { dirFromRaDec, enuToAltAz, raDecFromDir } from '../math/frames';
import type { AltAz, RaDec } from '../math/frames';
import { aberrate, apparentStarAt } from '../math/properMotion';
import { rotate } from '../math/quaternion';
import { yearsSinceEpoch } from '../math/time';
import { at, load3, vec3 } from '../math/typed';
import type { Vec3 } from '../math/typed';
import type { StarCatalogInput } from './types';

export type ResolvedKind = 'star' | 'dso' | 'body' | 'minor' | 'con';

/** What an id names: the kind and its row (catalog) or slot (frame window) index. */
export interface Resolved {
  kind: ResolvedKind;
  index: number;
}

const HIP_PREFIX = 'hip:';
const DSO_PREFIX = 'dso:';
const CON_PREFIX = 'con:';
const ASTEROID_PREFIX = 'a:';
const COMET_PREFIX = 'c:';
/** Memoised index of an id that names nothing. */
const UNKNOWN = -2;
/** Memoised index of a body or minor body: looked up in the current window on every call. */
const DYNAMIC = -1;
const NO_ENTRIES: readonly DsoEntry[] = [];
const NO_CONSTELLATIONS: readonly ConstellationEntry[] = [];

export class SkyResolver {
  private catalog: StarCatalogInput | null = null;
  private dso: readonly DsoEntry[] = NO_ENTRIES;
  private readonly dsoRows = new Map<string, number>();
  private dsoDirs = new Float64Array(0);
  private cons: readonly ConstellationEntry[] = NO_CONSTELLATIONS;
  private readonly conRows = new Map<string, number>();
  private conDirs = new Float64Array(0);
  private frame: FrameEval;
  private refractionOn = false;
  private refractionFactor = 1;
  private lastId: string | null = null;
  private lastKind: ResolvedKind = 'body';
  private lastIndex = DYNAMIC;
  /** The result of the last successful `resolve` (reused, never copied). */
  readonly resolved: Resolved = { kind: 'body', index: -1 };
  private readonly scratchIcrf: Vec3 = vec3();
  private readonly scratchEnu: Vec3 = vec3();
  private readonly scratchAltAz: AltAz = { alt: 0, az: 0 };
  private readonly scratchRaDec: RaDec = { ra: 0, dec: 0 };

  constructor(frame: FrameEval) {
    this.frame = frame;
  }

  /** The engine re-creates its `FrameEval` when `/meta` grows the capacity. */
  setFrame(frame: FrameEval): void {
    this.frame = frame;
  }

  setCatalog(catalog: StarCatalogInput | null): void {
    this.catalog = catalog;
    this.lastId = null;
  }

  /** Index the deep-sky objects (id and Messier alias) and the constellation label points. */
  setBundle(bundle: CatalogBundle | null): void {
    this.lastId = null;
    this.dsoRows.clear();
    this.conRows.clear();
    this.dso = bundle?.dso?.data ?? NO_ENTRIES;
    this.dsoDirs = new Float64Array(3 * this.dso.length);
    this.dso.forEach((entry, row) => {
      // Upper-cased keys: `/sky/altaz` and the details panel match `dso:` ids and Messier
      // aliases regardless of case, and the store never canonicalises `sel` (plan D92).
      this.dsoRows.set(entry.id.toUpperCase(), row);
      if (entry.messier !== undefined && entry.messier !== null) {
        this.dsoRows.set(`M${String(entry.messier)}`, row);
      }
      dirFromRaDec(this.scratchIcrf, entry.ra_deg, entry.dec_deg);
      this.dsoDirs.set(this.scratchIcrf, 3 * row);
    });
    this.cons = bundle?.constellations?.data ?? NO_CONSTELLATIONS;
    this.conDirs = new Float64Array(3 * this.cons.length);
    this.cons.forEach((entry, row) => {
      this.conRows.set(entry.abbr, row);
      dirFromRaDec(this.scratchIcrf, entry.label.ra_deg, entry.label.dec_deg);
      this.conDirs.set(this.scratchIcrf, 3 * row);
    });
  }

  setRefraction(on: boolean, factor: number): void {
    this.refractionOn = on;
    this.refractionFactor = factor;
  }

  get dsoEntries(): readonly DsoEntry[] {
    return this.dso;
  }

  /** ICRS unit vectors of the deep-sky objects, `3 * count`, in catalog order. */
  get dsoDirections(): Float64Array {
    return this.dsoDirs;
  }

  get constellations(): readonly ConstellationEntry[] {
    return this.cons;
  }

  /** ICRS unit vectors of the constellation label points, `3 * count`. */
  get constellationDirections(): Float64Array {
    return this.conDirs;
  }

  /** Row of a DSO id or Messier alias (without the `dso:` prefix, any case), `-1` when unknown. */
  dsoRow(id: string): number {
    return this.dsoRows.get(id.toUpperCase()) ?? -1;
  }

  /** Row of a constellation abbreviation, `-1` when unknown. */
  constellationRow(abbr: string): number {
    return this.conRows.get(abbr) ?? -1;
  }

  /**
   * Parse an id into what it names, or `null` when unknown or (for a body or minor body) not in
   * the current window. The parse is memoised on the id; the window lookups run on every call.
   */
  resolve(id: string): Resolved | null {
    if (id !== this.lastId) {
      this.lastId = id;
      this.lastKind = 'body';
      this.lastIndex = DYNAMIC;
      if (id.startsWith(HIP_PREFIX)) {
        this.lastKind = 'star';
        const row = this.catalog?.hipIndex.get(Number.parseInt(id.slice(HIP_PREFIX.length), 10));
        this.lastIndex = row ?? UNKNOWN;
      } else if (id.startsWith(DSO_PREFIX)) {
        this.lastKind = 'dso';
        this.lastIndex = this.dsoRows.get(id.slice(DSO_PREFIX.length).toUpperCase()) ?? UNKNOWN;
      } else if (id.startsWith(CON_PREFIX)) {
        this.lastKind = 'con';
        this.lastIndex = this.conRows.get(id.slice(CON_PREFIX.length)) ?? UNKNOWN;
      } else if (id.startsWith(ASTEROID_PREFIX) || id.startsWith(COMET_PREFIX)) {
        this.lastKind = 'minor';
      }
    }
    if (this.lastIndex === UNKNOWN) {
      return null;
    }
    const kind = this.lastKind;
    const out = this.resolved;
    if (kind === 'body' || kind === 'minor') {
      const frame = this.frame;
      if (!frame.valid) {
        return null;
      }
      const ids = kind === 'body' ? frame.bodyIds : frame.minorIds;
      const count = kind === 'body' ? frame.bodyCount : frame.minorCount;
      const index = ids.indexOf(id);
      if (index < 0 || index >= count) {
        return null;
      }
      if (kind === 'minor' && at(frame.minorDrawn, index) !== 1) {
        return null;
      }
      out.kind = kind;
      out.index = index;
      return out;
    }
    out.kind = kind;
    out.index = this.lastIndex;
    return out;
  }

  /**
   * The apparent ICRF direction of an id into `out` (stars: proper motion then aberration; DSO:
   * aberration; bodies and minor bodies: the evaluated direction; constellations: the label point),
   * or `null` when unknown or before the first window.
   */
  icrfDirectionOf(id: string, out: Vec3): Resolved | null {
    const frame = this.frame;
    if (!frame.valid) {
      return null;
    }
    const resolved = this.resolve(id);
    if (resolved === null) {
      return null;
    }
    switch (resolved.kind) {
      case 'star': {
        const catalog = this.catalog;
        if (catalog === null) {
          return null;
        }
        apparentStarAt(
          out,
          catalog.columns.dir,
          catalog.columns.pm,
          resolved.index,
          yearsSinceEpoch(frame.tt, catalog.columns.epochTt),
          frame.observerVelocity,
        );
        return resolved;
      }
      case 'dso':
        load3(out, this.dsoDirs, 3 * resolved.index);
        aberrate(out, out, frame.observerVelocity);
        return resolved;
      case 'con':
        load3(out, this.conDirs, 3 * resolved.index);
        return resolved;
      case 'body':
        load3(out, frame.dir, 3 * resolved.index);
        return resolved;
      case 'minor':
        load3(out, frame.minorDir, 3 * resolved.index);
        return resolved;
    }
  }

  /** The apparent ENU direction the engine renders for an id (refracted when refraction applies). */
  directionOf(id: string, out: Vec3): boolean {
    if (this.icrfDirectionOf(id, out) === null) {
      return false;
    }
    enuFromApparentIcrf(out, out, this.frame.horizonQ, this.refractionOn, this.refractionFactor);
    return true;
  }

  /** The full readout of an id into `out` (`out.valid` false when unknown). */
  readoutOf(id: string, out: SelectionReadout): boolean {
    const icrf = this.scratchIcrf;
    const resolved = this.icrfDirectionOf(id, icrf);
    if (resolved === null) {
      out.valid = false;
      return false;
    }
    const frame = this.frame;
    out.id = id;
    out.tt = frame.tt;
    out.valid = true;
    const icrs = raDecFromDir(this.scratchRaDec, icrf);
    out.raIcrs = icrs.ra;
    out.decIcrs = icrs.dec;
    const ofDate = raDecFromDir(this.scratchRaDec, rotate(this.scratchEnu, frame.equinoxQ, icrf));
    out.raDate = ofDate.ra;
    out.decDate = ofDate.dec;
    const enu = rotate(this.scratchEnu, frame.horizonQ, icrf);
    const altAz = enuToAltAz(this.scratchAltAz, enu[0], enu[1], enu[2]);
    out.altTrue = altAz.alt;
    out.az = altAz.az;
    if (this.refractionOn) {
      const refracted = enuFromApparentIcrf(
        this.scratchEnu,
        icrf,
        frame.horizonQ,
        true,
        this.refractionFactor,
      );
      out.alt = enuToAltAz(this.scratchAltAz, refracted[0], refracted[1], refracted[2]).alt;
    } else {
      out.alt = altAz.alt;
    }
    out.distAu = NaN;
    out.mag = NaN;
    out.phase = NaN;
    out.diamDeg = NaN;
    switch (resolved.kind) {
      case 'body':
        out.distAu = at(frame.distAu, resolved.index);
        out.mag = at(frame.mag, resolved.index);
        out.phase = at(frame.phase, resolved.index);
        out.diamDeg = at(frame.diamDeg, resolved.index);
        break;
      case 'minor':
        out.distAu = at(frame.minorDistAu, resolved.index);
        out.mag = at(frame.minorMag, resolved.index);
        out.phase = at(frame.minorPhase, resolved.index);
        out.diamDeg = at(frame.minorDiamDeg, resolved.index);
        break;
      case 'star':
        if (this.catalog !== null) {
          out.mag = at(this.catalog.columns.mag, resolved.index) / 1000;
        }
        break;
      case 'dso': {
        const entry = this.dso[resolved.index];
        if (entry !== undefined) {
          out.mag = entry.mag ?? NaN;
          out.diamDeg =
            entry.major_arcmin === undefined || entry.major_arcmin === null
              ? NaN
              : entry.major_arcmin / 60;
        }
        break;
      }
      case 'con':
        break;
    }
    return true;
  }
}

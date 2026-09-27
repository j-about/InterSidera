// Constellation figures and boundaries (SKY-5, brief l.213, plan D103). Lines: the Stellarium
// `modern` HIP pairs, endpoints recomputed at <= 10 Hz from the star catalog through the CPU
// direction twin (they follow proper motion, brief l.150) into one updatable LinesMesh created
// with vertex colours, so the highlight of the selected constellation, the dimming of the others
// and the night palette live in the `ColorKind` buffer alone (a vertex-coloured LinesMesh ignores
// `mesh.color` and `mesh.alpha`). Boundaries: the served ICRS J2000 rings drawn as chords
// (verified: the edges are precessed B1875 corners, so no client-side densification is
// correct; backlog B-61) and rotated by the horizon quaternion at <= 10 Hz. Rendering group 1
// with the reference overlays, under the frozen world matrix P (ADR-0009).

import type { ConstellationEntry } from '../../../api/catalogs';
import type { FrameEval, LayerFlags } from '../../../state/types';
import { apparentStarEnuAt } from '../../math/apparent';
import { SKY_RADIUS, dirFromRaDec } from '../../math/frames';
import { rotatePointsInPlace } from '../../math/lines';
import { yearsSinceEpoch } from '../../math/time';
import { at, load3, vec3 } from '../../math/typed';
import { Color4, CreateLineSystem, Vector3, VertexBuffer } from '../babylon';
import type { LinesMesh, Matrix, Scene } from '../babylon';
import type { StarCatalogInput } from '../types';

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const LINE_BASE: Rgba = { r: 0.45, g: 0.6, b: 0.85, a: 0.55 };
const LINE_DIM: Rgba = { r: 0.45, g: 0.6, b: 0.85, a: 0.28 };
const LINE_HIGHLIGHT: Rgba = { r: 0.98, g: 0.86, b: 0.45, a: 1 };
const BOUND_BASE: Rgba = { r: 0.68, g: 0.48, b: 0.78, a: 0.45 };
const BOUND_DIM: Rgba = { r: 0.68, g: 0.48, b: 0.78, a: 0.25 };
const BOUND_HIGHLIGHT: Rgba = { r: 0.98, g: 0.86, b: 0.45, a: 0.9 };
const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

/** A LinesMesh with its flat point buffer, colour buffer and the constellation of each point. */
interface LineSet {
  mesh: LinesMesh;
  positions: Float32Array;
  colors: Float32Array;
  /** Constellation index of every point (for the highlight). */
  pointCon: Int32Array;
  points: number;
}

/** Scale unit vectors in place to the sky radius. */
function scaleToSky(data: Float32Array): void {
  for (let k = 0; k < data.length; k += 1) {
    data[k] = at(data, k) * SKY_RADIUS;
  }
}

/** Babylon needs `Vector3[][]` and `Color4[][]` once, at creation; later updates reuse flat arrays. */
function toLines(data: Float32Array, counts: readonly number[]): Vector3[][] {
  const lines: Vector3[][] = [];
  let offset = 0;
  for (const count of counts) {
    const line: Vector3[] = [];
    for (let k = 0; k < count; k += 1) {
      const o = 3 * (offset + k);
      line.push(new Vector3(at(data, o), at(data, o + 1), at(data, o + 2)));
    }
    lines.push(line);
    offset += count;
  }
  return lines;
}

function toColors(colors: Float32Array, counts: readonly number[]): Color4[][] {
  const out: Color4[][] = [];
  let offset = 0;
  for (const count of counts) {
    const line: Color4[] = [];
    for (let k = 0; k < count; k += 1) {
      const o = 4 * (offset + k);
      line.push(new Color4(at(colors, o), at(colors, o + 1), at(colors, o + 2), at(colors, o + 3)));
    }
    out.push(line);
    offset += count;
  }
  return out;
}

export class ConstellationLayer {
  private readonly scene: Scene;
  private readonly worldMatrix: Matrix;
  private lines: LineSet | null = null;
  private bounds: LineSet | null = null;
  private constellations: readonly ConstellationEntry[] = [];
  private catalog: StarCatalogInput | null = null;
  /** Catalog rows of the distinct line stars and their apparent ENU directions (3 per star). */
  private starRows = new Int32Array(0);
  private starEnu = new Float64Array(0);
  /** Per segment: indices into `starRows` of both ends. */
  private segmentA = new Int32Array(0);
  private segmentB = new Int32Array(0);
  /** Boundary vertices in ICRS (unit), copied and rotated into the mesh buffer on every update. */
  private boundsIcrf = new Float32Array(0);
  /** Boundary chords drawn: every ring's point count minus one (`stats().cboundsSegments`). */
  private boundsSegments = 0;
  private highlight = -1;
  private nightOn = false;
  private nightLevel = 1;
  private showLines = false;
  private showBounds = false;
  private readonly scratch = vec3();
  /** The two endpoints of a segment (plan D144: read through `load3`, never boxed by `at`). */
  private readonly endA = vec3();
  private readonly endB = vec3();

  constructor(scene: Scene, worldMatrix: Matrix) {
    this.scene = scene;
    this.worldMatrix = worldMatrix;
  }

  /**
   * Line segments built from the catalog (both HIP ends resolved), `stats().clinesSegments`: a
   * catalog count that stands whatever `layers.clines` says (the mesh is hidden, not emptied).
   */
  get segmentCount(): number {
    return this.segmentA.length;
  }

  /**
   * Boundary chords built from the catalog, `stats().cboundsSegments` (plan D141): like
   * `segmentCount`, a catalog count that stands whatever `layers.cbounds` says.
   */
  get boundsSegmentCount(): number {
    return this.boundsSegments;
  }

  /** IAU abbreviation of the highlighted constellation, `null` when none (plan D141). */
  get highlightAbbr(): string | null {
    return this.constellations[this.highlight]?.abbr ?? null;
  }

  /**
   * Build the meshes once the constellations and the star catalog are both known (the lines
   * need `hipIndex`); either absent leaves the layer empty.
   */
  setData(
    constellations: readonly ConstellationEntry[] | null,
    catalog: StarCatalogInput | null,
  ): void {
    this.disposeMeshes();
    this.constellations = constellations ?? [];
    this.catalog = catalog;
    if (constellations === null || catalog === null || constellations.length === 0) {
      return;
    }
    this.buildLines(constellations, catalog);
    this.buildBounds(constellations);
    this.applyVisibility();
    this.recolor();
  }

  private buildLines(
    constellations: readonly ConstellationEntry[],
    catalog: StarCatalogInput,
  ): void {
    const rowOf = new Map<number, number>();
    const rows: number[] = [];
    const segA: number[] = [];
    const segB: number[] = [];
    const segCon: number[] = [];
    const distinct = (row: number): number => {
      const known = rowOf.get(row);
      if (known !== undefined) {
        return known;
      }
      rowOf.set(row, rows.length);
      rows.push(row);
      return rows.length - 1;
    };
    constellations.forEach((entry, con) => {
      for (const [a, b] of entry.lines) {
        const rowA = catalog.hipIndex.get(a);
        const rowB = catalog.hipIndex.get(b);
        if (rowA === undefined || rowB === undefined) {
          continue;
        }
        segA.push(distinct(rowA));
        segB.push(distinct(rowB));
        segCon.push(con);
      }
    });
    this.starRows = Int32Array.from(rows);
    this.starEnu = new Float64Array(3 * rows.length);
    this.segmentA = Int32Array.from(segA);
    this.segmentB = Int32Array.from(segB);
    const segments = segA.length;
    if (segments === 0) {
      return;
    }
    const points = 2 * segments;
    const positions = new Float32Array(3 * points);
    const colors = new Float32Array(4 * points);
    const pointCon = new Int32Array(points);
    const counts: number[] = [];
    for (let s = 0; s < segments; s += 1) {
      counts.push(2);
      pointCon[2 * s] = at(segCon, s);
      pointCon[2 * s + 1] = at(segCon, s);
    }
    // Identity geometry until the first update: the mesh stays hidden without a frame anyway.
    const mesh = CreateLineSystem(
      'clines',
      {
        lines: toLines(positions, counts),
        colors: toColors(colors, counts),
        updatable: true,
        useVertexAlpha: true,
      },
      this.scene,
    );
    this.lines = { mesh: this.prepare(mesh), positions, colors, pointCon, points };
  }

  private buildBounds(constellations: readonly ConstellationEntry[]): void {
    const counts: number[] = [];
    const conOf: number[] = [];
    let total = 0;
    constellations.forEach((entry, con) => {
      for (const ring of entry.polygons) {
        if (ring.length < 2) {
          continue;
        }
        counts.push(ring.length);
        conOf.push(con);
        total += ring.length;
      }
    });
    this.boundsSegments = total - counts.length;
    if (total === 0) {
      return;
    }
    const icrf = new Float32Array(3 * total);
    const pointCon = new Int32Array(total);
    let offset = 0;
    let ringIndex = 0;
    for (const entry of constellations) {
      for (const ring of entry.polygons) {
        if (ring.length < 2) {
          continue;
        }
        const con = at(conOf, ringIndex);
        ringIndex += 1;
        for (const [ra, dec] of ring) {
          dirFromRaDec(this.scratch, ra, dec);
          icrf.set(this.scratch, 3 * offset);
          pointCon[offset] = con;
          offset += 1;
        }
      }
    }
    this.boundsIcrf = icrf;
    const positions = new Float32Array(icrf);
    scaleToSky(positions);
    const colors = new Float32Array(4 * total);
    const mesh = CreateLineSystem(
      'cbounds',
      {
        lines: toLines(positions, counts),
        colors: toColors(colors, counts),
        updatable: true,
        useVertexAlpha: true,
      },
      this.scene,
    );
    this.bounds = { mesh: this.prepare(mesh), positions, colors, pointCon, points: total };
  }

  private prepare(mesh: LinesMesh): LinesMesh {
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.doNotSyncBoundingInfo = true;
    mesh.isPickable = false;
    mesh.renderingGroupId = 1;
    mesh.isVisible = false;
    // Own copy of P per mesh (see LineLayers.build).
    mesh.freezeWorldMatrix(this.worldMatrix.clone());
    return mesh;
  }

  /** `clines` and `cbounds` flags; both wait for the first frame window (the rotation). */
  setVisibility(layers: LayerFlags, hasFrame: boolean): void {
    this.showLines = layers.clines && hasFrame;
    this.showBounds = layers.cbounds && hasFrame;
    this.applyVisibility();
  }

  private applyVisibility(): void {
    if (this.lines !== null) {
      this.lines.mesh.isVisible = this.showLines;
    }
    if (this.bounds !== null) {
      this.bounds.mesh.isVisible = this.showBounds;
    }
  }

  /** Highlight the constellation `abbr` (`details.con`, plan D103); `null` clears it. */
  setHighlight(abbr: string | null): void {
    const index = abbr === null ? -1 : this.constellations.findIndex((c) => c.abbr === abbr);
    if (index !== this.highlight) {
      this.highlight = index;
      this.recolor();
    }
  }

  /** Night mode (plan D108): the palette is rewritten into the colour buffers. */
  setNight(on: boolean, level: number): void {
    if (on !== this.nightOn || level !== this.nightLevel) {
      this.nightOn = on;
      this.nightLevel = level;
      this.recolor();
    }
  }

  /** Rewrite both colour buffers (change-time only: selection, night). */
  private recolor(): void {
    if (this.lines !== null) {
      this.writeColors(this.lines, LINE_BASE, LINE_DIM, LINE_HIGHLIGHT);
    }
    if (this.bounds !== null) {
      this.writeColors(this.bounds, BOUND_BASE, BOUND_DIM, BOUND_HIGHLIGHT);
    }
  }

  private writeColors(set: LineSet, base: Rgba, dim: Rgba, highlight: Rgba): void {
    const colors = set.colors;
    for (let p = 0; p < set.points; p += 1) {
      const con = at(set.pointCon, p);
      const style = this.highlight < 0 ? base : con === this.highlight ? highlight : dim;
      const o = 4 * p;
      if (this.nightOn) {
        const l = (style.r * LUMA_R + style.g * LUMA_G + style.b * LUMA_B) * this.nightLevel;
        colors[o] = l;
        colors[o + 1] = 0;
        colors[o + 2] = 0;
      } else {
        colors[o] = style.r;
        colors[o + 1] = style.g;
        colors[o + 2] = style.b;
      }
      colors[o + 3] = style.a;
    }
    set.mesh.updateVerticesData(VertexBuffer.ColorKind, colors, false, false);
  }

  /**
   * Refresh the visible geometry (<= 10 Hz, brief l.68): line endpoints from the star catalog
   * through the CPU twin (proper motion, aberration, rotation, refraction), boundary chords
   * rotated by the horizon quaternion. The boundaries are unrefracted like the M3 grids (they
   * mark the sky, not a star): near the horizon a ring and the figure it encloses may differ
   * by the refraction (up to ~0.5 degrees), a deliberate choice recorded in the backlog.
   */
  update(frame: FrameEval, refractionOn: boolean, refractionFactor: number): void {
    const lines = this.lines;
    const catalog = this.catalog;
    if (lines !== null && catalog !== null && lines.mesh.isVisible) {
      const years = yearsSinceEpoch(frame.tt, catalog.columns.epochTt);
      const enu = this.scratch;
      for (let s = 0; s < this.starRows.length; s += 1) {
        apparentStarEnuAt(
          enu,
          catalog.columns,
          at(this.starRows, s),
          years,
          frame.observerVelocity,
          frame.horizonQ,
          refractionOn,
          refractionFactor,
        );
        this.starEnu[3 * s] = enu[0];
        this.starEnu[3 * s + 1] = enu[1];
        this.starEnu[3 * s + 2] = enu[2];
      }
      // The endpoints go through `load3` (plan D144, the measured site): `at` over a
      // `Float64Array` boxed every coordinate it returned (its keyed load is megamorphic), about
      // 4,200 reads per overlay tick here.
      const positions = lines.positions;
      const starEnu = this.starEnu;
      const endA = this.endA;
      const endB = this.endB;
      for (let s = 0; s < this.segmentA.length; s += 1) {
        load3(endA, starEnu, 3 * at(this.segmentA, s));
        load3(endB, starEnu, 3 * at(this.segmentB, s));
        const o = 6 * s;
        positions[o] = endA[0] * SKY_RADIUS;
        positions[o + 1] = endA[1] * SKY_RADIUS;
        positions[o + 2] = endA[2] * SKY_RADIUS;
        positions[o + 3] = endB[0] * SKY_RADIUS;
        positions[o + 4] = endB[1] * SKY_RADIUS;
        positions[o + 5] = endB[2] * SKY_RADIUS;
      }
      lines.mesh.updateVerticesData(VertexBuffer.PositionKind, positions, false, false);
    }
    const bounds = this.bounds;
    if (bounds?.mesh.isVisible === true) {
      bounds.positions.set(this.boundsIcrf);
      rotatePointsInPlace(bounds.positions, 0, bounds.points, frame.horizonQ);
      scaleToSky(bounds.positions);
      bounds.mesh.updateVerticesData(VertexBuffer.PositionKind, bounds.positions, false, false);
    }
  }

  private disposeMeshes(): void {
    this.lines?.mesh.dispose();
    this.bounds?.mesh.dispose();
    this.lines = null;
    this.bounds = null;
    this.starRows = new Int32Array(0);
    this.starEnu = new Float64Array(0);
    this.segmentA = new Int32Array(0);
    this.segmentB = new Int32Array(0);
    this.boundsIcrf = new Float32Array(0);
    this.boundsSegments = 0;
  }

  dispose(): void {
    this.disposeMeshes();
  }
}
